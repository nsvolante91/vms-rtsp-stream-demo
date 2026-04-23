/**
 * WebSocket receiver for the VMS binary streaming protocol.
 *
 * Provides a transport fallback for browsers that do not support WebTransport
 * (Safari, Firefox). Connects to the bridge server's WebSocket endpoint via the
 * Vite dev server proxy (wss://vite-host/ws → ws://bridge:9000/ws), so no
 * separate certificate trust is required.
 *
 * Protocol (same binary format as WebTransport, without length-prefix framing):
 * - Client → Server: JSON text messages `{ type, streamId }`
 * - Server → Client: Binary ArrayBuffer messages with 12-byte header:
 *   - Version:   1 byte  (0x01)
 *   - StreamID:  2 bytes (uint16 big-endian)
 *   - Timestamp: 8 bytes (uint64 big-endian, microseconds)
 *   - Flags:     1 byte  (bit 0 = keyframe, bit 1 = config/SPS+PPS)
 *   - Payload:   remaining bytes (H.264 Annex B)
 */

import { Logger } from '../utils/logger';
import type { ReceivedFrame, FrameCallback } from './wt-receiver';
import type { StreamReceiver } from './stream-pipeline';

export type { ReceivedFrame, FrameCallback };

const HEADER_SIZE = 12;
const PROTOCOL_VERSION = 0x01;

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * WebSocket-based receiver that connects to the bridge server and dispatches
 * H.264 frame data to registered stream callbacks.
 *
 * Implements the same {@link StreamReceiver} interface as WTReceiver so the
 * worker can swap transports transparently based on browser support.
 */
export class WSReceiver implements StreamReceiver {
  private ws: WebSocket | null = null;
  private readonly callbacks: Map<number, FrameCallback> = new Map();
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  /** Pooled ReceivedFrame object reused across parseBinaryFrame calls */
  private readonly _pooledFrame: ReceivedFrame = {
    streamId: 0,
    timestamp: 0n,
    isKeyframe: false,
    isConfig: false,
    data: new Uint8Array(0),
  };

  /**
   * @param wsUrl - WebSocket server URL (e.g. "wss://hostname:5173/ws")
   */
  constructor(private readonly wsUrl: string) {
    this.log = new Logger('WSReceiver');
  }

  /**
   * Connect to the WebSocket server.
   *
   * Returns a Promise that resolves once the socket is open, or rejects
   * if the connection fails immediately (triggering the reconnect loop).
   */
  connect(): Promise<void> {
    this.closing = false;

    return new Promise<void>((resolve, reject) => {
      this.log.info(`Connecting to ${this.wsUrl}`);

      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.log.info('WebSocket connected');
        this.ws = ws;
        this.reconnectAttempt = 0;

        // Re-subscribe to any streams that were registered before connect
        for (const streamId of this.callbacks.keys()) {
          this.sendSubscribe(streamId);
        }

        resolve();
      };

      ws.onerror = () => {
        // onerror always precedes onclose; log here, clean up in onclose
        this.log.warn('WebSocket error');
      };

      ws.onclose = (ev) => {
        this.ws = null;
        if (!this.closing) {
          this.log.warn(`WebSocket closed (code=${ev.code}), scheduling reconnect`);
          this.scheduleReconnect();
        }
        // Reject the initial connect promise if we never opened
        reject(new Error(`WebSocket closed before opening (code=${ev.code})`));
      };

      ws.onmessage = (ev: MessageEvent<ArrayBuffer | string>) => {
        if (typeof ev.data === 'string') {
          // Control message from server (currently unused client-side)
          return;
        }
        this.parseBinaryFrame(new Uint8Array(ev.data));
      };
    });
  }

  /**
   * Subscribe to a stream and register a frame callback.
   *
   * @param streamId - Numeric stream identifier
   * @param callback - Invoked for each received frame
   */
  subscribe(streamId: number, callback: FrameCallback): void {
    this.callbacks.set(streamId, callback);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(streamId);
    }
  }

  /**
   * Unsubscribe from a stream.
   *
   * @param streamId - Numeric stream identifier
   */
  unsubscribe(streamId: number): void {
    this.callbacks.delete(streamId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', streamId }));
    }
  }

  /** Close the connection and stop all reconnection attempts. */
  close(): void {
    this.closing = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.callbacks.clear();
    this.log.info('Closed');
  }

  /** Whether the WebSocket is currently open. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private sendSubscribe(streamId: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', streamId }));
      this.log.info(`Subscribed to stream ${streamId}`);
    }
  }

  /**
   * Parse a binary frame and dispatch to the appropriate callback.
   *
   * Reuses a single pooled ReceivedFrame to avoid per-frame allocation.
   * Safe because callbacks are invoked synchronously.
   *
   * @param buffer - Raw frame bytes (12-byte header + payload)
   */
  private parseBinaryFrame(buffer: Uint8Array): void {
    if (buffer.byteLength < HEADER_SIZE) {
      this.log.warn(`Frame too short: ${buffer.byteLength} bytes`);
      return;
    }

    const version = buffer[0];
    if (version !== PROTOCOL_VERSION) {
      this.log.warn(`Unknown protocol version: ${version}`);
      return;
    }

    const streamId = (buffer[1] << 8) | buffer[2];

    const hi =
      ((buffer[3] << 24) | (buffer[4] << 16) | (buffer[5] << 8) | buffer[6]) >>> 0;
    const lo =
      ((buffer[7] << 24) | (buffer[8] << 16) | (buffer[9] << 8) | buffer[10]) >>> 0;
    const timestamp = (BigInt(hi) << 32n) | BigInt(lo);

    const flags = buffer[11];
    const isKeyframe = (flags & 0x01) !== 0;
    const isConfig = (flags & 0x02) !== 0;
    const data = buffer.subarray(HEADER_SIZE);

    const callback = this.callbacks.get(streamId);
    if (callback) {
      this._pooledFrame.streamId = streamId;
      this._pooledFrame.timestamp = timestamp;
      this._pooledFrame.isKeyframe = isKeyframe;
      this._pooledFrame.isConfig = isConfig;
      this._pooledFrame.data = data;
      callback(this._pooledFrame);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;

    this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // onclose already schedules the next attempt
      });
    }, delay);
  }
}
