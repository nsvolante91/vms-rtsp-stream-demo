/**
 * WebSocket transport handler for the bridge server.
 *
 * Provides a WebSocket fallback for browsers that do not support
 * WebTransport (e.g. Safari, Firefox). Runs on the same HTTP server
 * and integrates with the shared StreamManager so both transport
 * layers deliver identical H.264 data from the same RTSP sources.
 *
 * Protocol:
 * - Client → Server: JSON text messages `{ type, streamId }`
 *   - `{ "type": "subscribe", "streamId": 1 }`
 *   - `{ "type": "unsubscribe", "streamId": 1 }`
 * - Server → Client: Binary messages with the same 12-byte protocol
 *   header as WebTransport (version + streamId + timestamp + flags + payload).
 *   No length-prefix framing is needed since WebSocket provides native
 *   message boundaries.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HTTPServer } from 'http';
import { StreamManager } from './stream-manager.js';

/**
 * Attach a WebSocket server to the existing HTTP server.
 *
 * Upgrades connections on the `/ws` path and registers each
 * connected client with the StreamManager for subscribe/unsubscribe
 * and binary frame delivery.
 *
 * @param httpServer - The existing HTTP/1.1 server to attach to
 * @param streamManager - Shared stream manager instance
 */
export function attachWebSocketServer(
  httpServer: HTTPServer,
  streamManager: StreamManager
): void {
  const wss = new WebSocketServer({ noServer: true });

  // Only upgrade requests to /ws
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', `http://localhost`).pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    console.log('[WS] New WebSocket client connected');
    streamManager.handleWebSocketClient(ws);
  });

  console.log('[WS] WebSocket server attached at /ws');
}
