/**
 * WebSocket receiver for the VMS binary streaming protocol.
 *
 * Fallback transport for browsers that don't support WebTransport.
 * Connects to the bridge server over a standard WebSocket and receives
 * the same 12-byte binary protocol as WebTransport, but without
 * length-prefix framing (WebSocket provides native message boundaries).
 *
 * Implements the same StreamReceiver interface as WTReceiver so both
 * transports are interchangeable from the pipeline's perspective.
 */

import { Logger } from '../utils/logger';
import type { ReceivedFrame, FrameCallback } from './wt-receiver';

/** Binary protocol constants (must match bridge server) */
const HEADER_SIZE = 12;
const PROTOCOL_VERSION = 0x01;

/** Maximum reconnection delay in milliseconds */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Base reconnection delay in milliseconds */
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * WebSocket receiver that connects to the bridge server and dispatches
 * H.264 frame data to registered stream callbacks.
 *
 * Uses a single WebSocket connection with JSON control messages for
 * subscribe/unsubscribe, and binary messages carrying the 12-byte
 * protocol header + H.264 payload.
 */
export class WSReceiver {
  private ws: WebSocket | null = null;
  private readonly callbacks = new Map<number, FrameCallback>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private _bytesReceived = 0;
  private _messageCount = 0;
  private closing = false;
  private readonly log = new Logger('WSReceiver');

  /** Pooled ReceivedFrame object reused across parseBinaryFrame calls */
  private readonly _pooledFrame: ReceivedFrame = {
    streamId: 0,
    timestamp: 0n,
    isKeyframe: false,
    isConfig: false,
    data: new Uint8Array(0),
  };

  constructor(private readonly wsUrl: string) {}

  /**
   * Connect to the WebSocket server.
   */
  async connect(): Promise<void> {
    this.closing = false;

    if (this.ws) {
      this.log.warn('Already connected or connecting');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.log.info(`Connecting to ${this.wsUrl}`);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.log.info('WebSocket connected');
        this.reconnectAttempt = 0;

        // Re-subscribe to any previously registered streams
        for (const streamId of this.callbacks.keys()) {
          this.sendSubscribe(streamId);
        }

        resolve();
      };

      this.ws.onerror = (ev) => {
        this.log.error('WebSocket error', ev);
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this.log.warn('WebSocket closed');
        this.ws = null;
        if (!this.closing) {
          this.scheduleReconnect();
        }
      };

      this.ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.handleBinaryMessage(ev.data);
        }
        // Ignore text messages (e.g. control acks from server)
      };
    });
  }

  /**
   * Subscribe to a stream and register a frame callback.
   */
  subscribe(streamId: number, callback: FrameCallback): void {
    this.callbacks.set(streamId, callback);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(streamId);
    }
  }

  /**
   * Unsubscribe from a stream.
   */
  unsubscribe(streamId: number): void {
    this.callbacks.delete(streamId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', streamId }));
    }
  }

  /**
   * Close the connection and stop all reconnection attempts.
   */
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

  get bytesReceived(): number { return this._bytesReceived; }
  get messageCount(): number { return this._messageCount; }
  get connected(): boolean { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  private sendSubscribe(streamId: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', streamId }));
    }
  }

  /**
   * Parse a binary message containing the 12-byte protocol header + payload.
   *
   * WebSocket messages don't have length-prefix framing since WS provides
   * native message boundaries. The server sends wsFrame (no 4-byte prefix).
   */
  private handleBinaryMessage(buffer: ArrayBuffer): void {
    const data = new Uint8Array(buffer);
    if (data.byteLength < HEADER_SIZE) {
      this.log.warn(`Runt message: ${data.byteLength} bytes`);
      return;
    }

    this._bytesReceived += data.byteLength;
    this._messageCount++;

    // Parse 12-byte header
    const version = data[0];
    if (version !== PROTOCOL_VERSION) {
      this.log.warn(`Unknown protocol version: ${version}`);
      return;
    }

    const streamId = (data[1] << 8) | data[2];
    // Read 8-byte timestamp as BigInt (uint64 big-endian)
    const view = new DataView(buffer);
    const timestampHi = view.getUint32(3, false);
    const timestampLo = view.getUint32(7, false);
    const timestamp = (BigInt(timestampHi) << 32n) | BigInt(timestampLo);
    const flags = data[11];

    const callback = this.callbacks.get(streamId);
    if (!callback) return;

    // Reuse pooled frame to avoid allocation
    this._pooledFrame.streamId = streamId;
    this._pooledFrame.timestamp = timestamp;
    this._pooledFrame.isKeyframe = (flags & 0x01) !== 0;
    this._pooledFrame.isConfig = (flags & 0x02) !== 0;
    this._pooledFrame.data = data.subarray(HEADER_SIZE);

    callback(this._pooledFrame);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer !== null) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;
    this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.log.error('Reconnect failed', err);
      });
    }, delay);
  }
}
