/**
 * Bridge Server Entry Point — WebTransport Edition
 *
 * HTTP/3 WebTransport server on port 9001 that bridges RTSP H.264 streams
 * to browser clients via multiplexed QUIC streams. Also provides an HTTP/1.1
 * REST API on port 9000 for stream management and certificate hash retrieval.
 *
 * REST Endpoints (HTTP/1.1 on port 9000):
 * - GET  /streams     — List all available streams
 * - POST /streams     — Add a new stream { rtspUrl }
 * - DELETE /streams/:id — Remove a stream
 * - GET  /cert-hash   — Get the TLS certificate SHA-256 hash for WebTransport pinning
 * - GET  /health      — Server health check
 *
 * WebTransport at https://localhost:9001/streams — Binary H.264 streaming
 * - Client opens a bidirectional stream for control (subscribe/unsubscribe)
 * - Server opens one unidirectional stream per subscribed video feed
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readdir } from 'fs/promises';
import { resolve as pathResolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Http3Server } from '@fails-components/webtransport';
import { StreamManager } from './stream-manager.js';
import { probeLocalFile } from './local-file-source.js';
import { generateCertificate, type CertMaterial } from './cert-utils.js';
import { attachWebSocketServer } from './ws-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = pathResolve(__dirname, '..', '..');

const HTTP_PORT = parseInt(process.env.BRIDGE_PORT ?? '9000', 10);
const WT_PORT = parseInt(process.env.WT_PORT ?? '9001', 10);
const RTSP_BASE_URL = process.env.RTSP_BASE_URL ?? '';
const SOURCE_MODE = process.env.SOURCE_MODE ?? 'auto';
const VIDEO_DIR = process.env.VIDEO_DIR ?? join(PROJECT_ROOT, 'test-videos');

const streamManager = new StreamManager();
let nextStreamId = 1;
let certMaterial: CertMaterial;

/**
 * Parse the request body as JSON.
 *
 * @param req - HTTP request
 * @returns Parsed JSON body
 */
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param res - HTTP response
 * @param statusCode - HTTP status code
 * @param data - Response data to serialize as JSON
 */
function sendJSON(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Handle incoming HTTP requests for the REST API.
 *
 * @param req - HTTP request
 * @param res - HTTP response
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://192.168.3.123:${HTTP_PORT}`);
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // GET /cert-hash — certificate fingerprint for WebTransport pinning
  if (url.pathname === '/cert-hash' && method === 'GET') {
    sendJSON(res, 200, {
      hash: certMaterial.hashHex,
      algorithm: 'sha-256',
      wtUrl: `https://localhost:${WT_PORT}/streams`,
    });
    return;
  }

  // GET /streams — list all streams
  if (url.pathname === '/streams' && method === 'GET') {
    const streams = streamManager.getStreams();
    sendJSON(res, 200, { streams });
    return;
  }

  // POST /streams — add a new stream
  if (url.pathname === '/streams' && method === 'POST') {
    try {
      const body = (await parseBody(req)) as { rtspUrl?: string; filePath?: string };
      const source = body.rtspUrl ?? body.filePath;
      if (!source || typeof source !== 'string') {
        sendJSON(res, 400, { error: 'rtspUrl or filePath is required' });
        return;
      }

      const id = nextStreamId++;
      const info = await streamManager.addStream(id, source);
      sendJSON(res, 201, { stream: info });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to add stream';
      sendJSON(res, 500, { error: message });
    }
    return;
  }

  // DELETE /streams/:id — remove a stream
  const deleteMatch = url.pathname.match(/^\/streams\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    const id = parseInt(deleteMatch[1], 10);
    streamManager.removeStream(id);
    sendJSON(res, 200, { success: true, streamId: id });
    return;
  }

  // Health check
  if (url.pathname === '/health' && method === 'GET') {
    sendJSON(res, 200, {
      status: 'ok',
      streams: streamManager.getStreams().length,
      clients: streamManager.getClientCount(),
    });
    return;
  }

  // 404 for everything else
  sendJSON(res, 404, { error: 'Not found' });
}

/**
 * Auto-discover local video files in VIDEO_DIR.
 *
 * Scans the directory for .mp4 files containing H.264 video and adds
 * each as a stream source.
 *
 * @returns true if any local streams were added
 */
async function discoverLocalFiles(): Promise<boolean> {
  const absDir = pathResolve(VIDEO_DIR);
  console.log(`[Discovery] Scanning local directory: ${absDir}`);

  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    console.warn(`[Discovery] Cannot read VIDEO_DIR: ${absDir}`);
    return false;
  }

  const mp4Files = entries
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => pathResolve(absDir, f));

  if (mp4Files.length === 0) {
    console.warn(`[Discovery] No .mp4 files found in ${absDir}`);
    return false;
  }

  // Probe files in parallel to check for H.264 video
  const probeResults = await Promise.all(
    mp4Files.map(async (filePath) => ({
      filePath,
      valid: await probeLocalFile(filePath),
    }))
  );

  const valid = probeResults.filter((r) => r.valid);
  console.log(
    `[Discovery] Found ${valid.length} H.264 file(s) out of ${mp4Files.length} MP4(s)`
  );

  for (const { filePath } of valid) {
    const id = nextStreamId++;
    try {
      await streamManager.addStream(id, filePath);
      const name = filePath.split('/').pop();
      console.log(`[Discovery] Added local file ${name} as stream ID ${id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Discovery] Failed to add ${filePath}: ${message}`);
    }
  }

  return valid.length > 0;
}

/**
 * Auto-discover an RTSP stream from RTSP_BASE_URL.
 *
 * Treats the URL as a direct camera stream and attempts to connect.
 */
async function discoverRtspStreams(): Promise<void> {
  console.log(`[Discovery] Connecting to RTSP URL: ${RTSP_BASE_URL}`);
  const id = nextStreamId++;
  try {
    await streamManager.addStream(id, RTSP_BASE_URL);
    console.log(`[Discovery] Added RTSP stream as ID ${id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Discovery] Failed to add RTSP stream: ${message}`);
  }
}

/**
 * Accept incoming WebTransport sessions from the Http3Server.
 *
 * Reads sessions from the session stream for the `/streams` path and
 * hands each one to the StreamManager for control/video multiplexing.
 *
 * @param sessionStream - ReadableStream of WebTransport sessions
 */
async function acceptSessions(
  sessionStream: ReadableStream<any>
): Promise<void> {
  const reader = sessionStream.getReader();

  try {
    while (true) {
      const { value: session, done } = await reader.read();
      if (done) break;

      console.log('[WT] New WebTransport session accepted');
      // Handle each session concurrently — don't block the accept loop
      streamManager.handleSession(session).catch((err) => {
        console.error('[WT] Session handler error:', err);
      });
    }
  } catch (err) {
    console.error('[WT] Session accept loop error:', err);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Start the bridge server.
 *
 * Creates an HTTP/1.1 REST API server and an HTTP/3 WebTransport server.
 * Generates a self-signed TLS certificate for WebTransport and exposes
 * its SHA-256 hash via the REST API. Auto-discovers RTSP streams on startup.
 */
async function main(): Promise<void> {
  // Generate self-signed ECDSA certificate for WebTransport
  console.log('[Bridge] Generating self-signed TLS certificate...');
  certMaterial = generateCertificate();
  console.log(`[Bridge] Certificate hash: ${certMaterial.hashHex}`);

  // Create HTTP/1.1 REST API server
  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[HTTP] Request handler error:', err);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: 'Internal server error' });
      }
    });
  });

  // Create HTTP/3 WebTransport server
  const wtServer = new Http3Server({
    port: WT_PORT,
    host: '0.0.0.0',
    secret: 'vms-bridge-secret',
    cert: certMaterial.cert,
    privKey: certMaterial.key,
  });

  // Register the /streams path for WebTransport sessions
  const sessionStream = wtServer.sessionStream('/streams');

  // Attach WebSocket fallback server on the HTTP server at /ws
  attachWebSocketServer(httpServer, streamManager);

  // Start servers
  httpServer.listen(HTTP_PORT, () => {
    console.log(`[Bridge] REST API listening on http://localhost:${HTTP_PORT}`);
    console.log(`[Bridge] Certificate hash: GET http://localhost:${HTTP_PORT}/cert-hash`);
  });

  wtServer.startServer();
  await wtServer.ready;
  console.log(`[Bridge] WebTransport server listening on https://localhost:${WT_PORT}/streams`);

  // Accept WebTransport sessions (runs in background)
  acceptSessions(sessionStream).catch((err) => {
    console.error('[Bridge] Fatal: session acceptor crashed:', err);
  });

  // Auto-discover streams based on SOURCE_MODE
  if (SOURCE_MODE === 'local') {
    const found = await discoverLocalFiles();
    if (!found) {
      console.warn('[Bridge] No local streams found. Add .mp4 files to VIDEO_DIR or switch SOURCE_MODE.');
    }
  } else if (SOURCE_MODE === 'rtsp') {
    await discoverRtspStreams();
  } else {
    // auto: try local files first, fall back to RTSP
    const foundLocal = await discoverLocalFiles();
    if (!foundLocal) {
      console.log('[Discovery] No local files found, falling back to RTSP discovery');
      await discoverRtspStreams();
    }
  }

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\n[Bridge] Shutting down...');
    streamManager.shutdown();
    wtServer.stopServer();
    httpServer.close(() => {
      console.log('[Bridge] Server stopped');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[Bridge] Forced exit after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});
