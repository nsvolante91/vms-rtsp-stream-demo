/**
 * Bridge Server Entry Point
 *
 * WebSocket server on port 9000 that bridges RTSP H.264 streams to browser
 * clients. Provides a REST API for stream management and auto-discovers
 * active streams on startup.
 *
 * REST Endpoints:
 * - GET  /streams     — List all available streams
 * - POST /streams     — Add a new stream { rtspUrl }
 * - DELETE /streams/:id — Remove a stream
 *
 * WebSocket at / — Binary frame protocol for H.264 streaming
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamManager } from './stream-manager.js';
import { probeRTSPStream } from './rtsp-client.js';

const PORT = parseInt(process.env.BRIDGE_PORT ?? '9000', 10);
const RTSP_BASE_URL = process.env.RTSP_BASE_URL ?? 'rtsp://localhost:8554';
const MAX_DISCOVER_STREAMS = 16;

const streamManager = new StreamManager();
let nextStreamId = 1;

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
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
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
 * Auto-discover active RTSP streams on the local MediaMTX server.
 *
 * Probes RTSP URLs from stream1 through stream16 and adds any that
 * respond successfully. Uses parallel probing for speed.
 */
async function discoverStreams(): Promise<void> {
  console.log(
    `[Discovery] Probing ${RTSP_BASE_URL}/stream1..stream${MAX_DISCOVER_STREAMS}`
  );

  const probePromises: Promise<{ index: number; available: boolean }>[] = [];

  for (let i = 1; i <= MAX_DISCOVER_STREAMS; i++) {
    const url = `${RTSP_BASE_URL}/stream${i}`;
    probePromises.push(
      probeRTSPStream(url, 5000).then((available) => ({
        index: i,
        available,
      }))
    );
  }

  const results = await Promise.all(probePromises);
  const available = results.filter((r) => r.available);

  console.log(
    `[Discovery] Found ${available.length} active stream(s): ${available.map((r) => `stream${r.index}`).join(', ') || 'none'}`
  );

  // Connect to discovered streams sequentially to avoid overwhelming FFmpeg
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
 * Start the bridge server.
 *
 * Creates an HTTP server for the REST API and upgrades WebSocket connections
 * for streaming. Auto-discovers RTSP streams on startup.
 */
async function main(): Promise<void> {
  // Create HTTP server
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[HTTP] Request handler error:', err);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: 'Internal server error' });
      }
    });
  });

  // Create WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteAddr =
      req.socket.remoteAddress ?? 'unknown';
    console.log(`[WS] Client connected from ${remoteAddr}`);
    streamManager.handleClient(ws);
  });

  wss.on('error', (err: Error) => {
    console.error('[WS] Server error:', err.message);
  });

  // Start listening
  server.listen(PORT, () => {
    console.log(`[Bridge] Server listening on port ${PORT}`);
    console.log(`[Bridge] REST API: http://localhost:${PORT}/streams`);
    console.log(`[Bridge] WebSocket: ws://localhost:${PORT}/`);
  });

  // Auto-discover streams
  await discoverStreams();

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('\n[Bridge] Shutting down...');
    streamManager.shutdown();
    wss.close();
    server.close(() => {
      console.log('[Bridge] Server stopped');
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      console.error('[Bridge] Forced exit after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the server
main().catch((err) => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});
