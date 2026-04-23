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
import * as net from 'net';
import { Http3Server } from '@fails-components/webtransport';
import { StreamManager } from './stream-manager.js';
import { probeRTSPStream } from './rtsp-client.js';
import { generateCertificate, type CertMaterial } from './cert-utils.js';
import { attachWebSocketServer } from './ws-handler.js';

const HTTP_PORT = parseInt(process.env.BRIDGE_PORT ?? '9000', 10);
const WT_PORT = parseInt(process.env.WT_PORT ?? '9001', 10);
const RTSP_BASE_URL = process.env.RTSP_BASE_URL ?? 'rtsp://localhost:8554';
const MAX_DISCOVER_STREAMS = parseInt(process.env.MAX_DISCOVER_STREAMS ?? '16', 10);

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
  const url = new URL(req.url ?? '/', `http://localhost:${HTTP_PORT}`);
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
      const body = (await parseBody(req)) as { rtspUrl?: string };
      if (!body.rtspUrl || typeof body.rtspUrl !== 'string') {
        sendJSON(res, 400, { error: 'rtspUrl is required' });
        return;
      }

      const id = nextStreamId++;
      const info = await streamManager.addStream(id, body.rtspUrl);
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
 * Check if a TCP host:port is reachable within a timeout.
 *
 * @param host - Hostname or IP to connect to
 * @param port - TCP port number
 * @param timeoutMs - Connection timeout in milliseconds
 * @returns true if the connection succeeded, false otherwise
 */
function checkTcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Auto-discover active RTSP streams.
 *
 * If RTSP_BASE_URL looks like a MediaMTX local server (contains localhost or
 * 127.0.0.1), probes stream1..streamN as sub-paths. Otherwise, treats the
 * base URL as a single direct RTSP stream (e.g. a real IP camera).
 */
async function discoverStreams(): Promise<void> {
  const isLocalMediaMTX =
    RTSP_BASE_URL.includes('localhost') ||
    RTSP_BASE_URL.includes('127.0.0.1');

  if (!isLocalMediaMTX) {
    // Direct camera URL — probe and add as a single stream
    console.log(`[Discovery] Probing direct RTSP URL: ${RTSP_BASE_URL}`);
    const id = nextStreamId++;
    try {
      await streamManager.addStream(id, RTSP_BASE_URL);
      console.log(`[Discovery] Added direct stream as ID ${id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Discovery] Failed to add direct stream: ${message}`);
    }
    return;
  }

  // Extract host and port from RTSP_BASE_URL for reachability check
  let rtspHost = 'localhost';
  let rtspPort = 8554;
  try {
    const parsed = new URL(RTSP_BASE_URL);
    rtspHost = parsed.hostname;
    rtspPort = parsed.port ? parseInt(parsed.port, 10) : 8554;
  } catch {
    // Fall back to defaults if URL parsing fails
  }

  // Check if the RTSP server is reachable before spawning ffprobe processes
  const reachable = await checkTcpReachable(rtspHost, rtspPort);
  if (!reachable) {
    console.error(
      `[Discovery] Cannot reach RTSP server at ${rtspHost}:${rtspPort}. ` +
      `Is MediaMTX running? Try: docker compose -f docker/docker-compose.yml up -d`
    );
    return;
  }

  // MediaMTX local server — probe stream1..streamN
  console.log(
    `[Discovery] Probing ${RTSP_BASE_URL} for up to ${MAX_DISCOVER_STREAMS} streams`
  );

  const probePromises: Promise<{ index: number; available: boolean }>[] = [];

  for (let i = 1; i <= MAX_DISCOVER_STREAMS; i++) {
    const url = `${RTSP_BASE_URL}/stream${i}`;
    probePromises.push(
      probeRTSPStream(url, 8000).then((available) => ({
        index: i,
        available,
      }))
    );
  }

  const results = await Promise.all(probePromises);
  const available = results.filter((r) => r.available);
  let failed = results.filter((r) => !r.available);

  console.log(
    `[Discovery] Found ${available.length} active stream(s): ${available.map((r) => `stream${r.index}`).join(', ') || 'none'}`
  );

  // Retry failed streams with exponential backoff (useful when FFmpeg
  // publishers haven't finished registering with MediaMTX yet)
  const retryDelays = [3000, 6000, 12000];
  for (let attempt = 0; attempt < retryDelays.length && failed.length > 0; attempt++) {
    console.log(
      `[Discovery] Retrying ${failed.length} stream(s) in ${retryDelays[attempt] / 1000}s: ` +
      failed.map((r) => `stream${r.index}`).join(', ')
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));

    const retryPromises = failed.map((r) => {
      const url = `${RTSP_BASE_URL}/stream${r.index}`;
      return probeRTSPStream(url, 8000).then((avail) => ({
        index: r.index,
        available: avail,
      }));
    });
    const retryResults = await Promise.all(retryPromises);
    const newlyAvailable = retryResults.filter((r) => r.available);
    failed = retryResults.filter((r) => !r.available);

    if (newlyAvailable.length > 0) {
      console.log(
        `[Discovery] Retry ${attempt + 1}: found ${newlyAvailable.length} stream(s): ` +
        newlyAvailable.map((r) => `stream${r.index}`).join(', ')
      );
      available.push(...newlyAvailable);
    }
  }

  if (failed.length > 0) {
    console.log(
      `[Discovery] Gave up on ${failed.length} stream(s) after retries: ` +
      failed.map((r) => `stream${r.index}`).join(', ')
    );
  }

  for (const result of available) {
    const url = `${RTSP_BASE_URL}/stream${result.index}`;
    const id = nextStreamId++;
    try {
      await streamManager.addStream(id, url);
      console.log(`[Discovery] Added stream${result.index} as stream ID ${id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error';
      console.error(
        `[Discovery] Failed to add stream${result.index}: ${message}`
      );
    }
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

  // Auto-discover RTSP streams
  await discoverStreams();

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
