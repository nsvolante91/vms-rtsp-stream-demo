/**
 * WebSocket receiver for the VMS binary streaming protocol.
 *
 * Connects to the bridge server, parses binary frames from the custom
 * protocol, and dispatches decoded frame data to per-stream callbacks.
 * Handles automatic reconnection with exponential backoff.
 */

import { Logger } from '../utils/logger';

/** A parsed frame received over the WebSocket binary protocol */
export interface ReceivedFrame {
  /** Numeric stream identifier */
  streamId: number;
  /** Presentation timestamp in microseconds */
  timestamp: bigint;
  /** Whether this frame is an IDR keyframe */
  isKeyframe: boolean;
  /** Whether this frame carries SPS/PPS configuration data */
  isConfig: boolean;
  /** Raw H.264 Annex B payload data */
  data: Uint8Array;
}

/** Callback invoked when a frame is received for a subscribed stream */
export type FrameCallback = (frame: ReceivedFrame) => void;

/**
 * Binary protocol header layout:
 *
 * - Version:   1 byte  (0x01)
 * - StreamID:  2 bytes (uint16 big-endian)
 * - Timestamp: 8 bytes (uint64 big-endian, microseconds)
 * - Flags:     1 byte  (bit 0 = keyframe, bit 1 = config/SPS+PPS)
 * - Payload:   remaining bytes (H.264 Annex B)
 */
const HEADER_SIZE = 12; // 1 + 2 + 8 + 1
const PROTOCOL_VERSION = 0x01;

/** Maximum reconnection delay in milliseconds */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Base reconnection delay in milliseconds */
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * WebSocket receiver that connects to the bridge server and dispatches
 * H.264 frame data to registered stream callbacks.
 *
 * Supports subscribing/unsubscribing to individual streams and
 * automatically reconnects on disconnection with exponential backoff.
 */
export class WSReceiver {
  private ws: WebSocket | null = null;
  private readonly callbacks: Map<number, FrameCallback> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private _bytesReceived = 0;
  private _messageCount = 0;
  private closing = false;
  private readonly log: Logger;

  /**
   * Create a new WSReceiver.
   * @param url - WebSocket server URL (e.g., "ws://localhost:9000")
   */
  constructor(private readonly url: string) {
    this.log = new Logger('WSReceiver');
  }

  /**
   * Connect to the WebSocket server.
   *
   * Configures the socket for binary mode and sets up event handlers
   * for message parsing, reconnection, and error reporting.
   */
  connect(): void {
    this.closing = false;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log.warn('Already connected or connecting');
      return;
    }

    this.log.info(`Connecting to ${this.url}`);
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.log.info('Connected');
      this.reconnectAttempt = 0;

      // Re-subscribe to any previously registered streams
      for (const streamId of this.callbacks.keys()) {
        this.sendSubscribe(streamId);
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else if (typeof event.data === 'string') {
        // Server sends JSON control messages (streams list, subscription confirmations)
        try {
          const msg = JSON.parse(event.data);
          this.log.info(`Control: ${msg.type ?? 'unknown'}`);
        } catch {
          // Ignore malformed control messages
        }
      }
    };

    this.ws.onclose = () => {
      this.log.warn('Connection closed');
      this.ws = null;
      if (!this.closing) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      this.log.error('WebSocket error', event);
    };
  }

  /**
   * Subscribe to a stream and register a frame callback.
   *
   * Sends a JSON subscribe message to the bridge server if connected.
   * The callback will also be stored so it is re-subscribed on reconnect.
   *
   * @param streamId - Numeric stream identifier
   * @param callback - Function invoked for each received frame
   */
  subscribe(streamId: number, callback: FrameCallback): void {
    this.callbacks.set(streamId, callback);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(streamId);
    }
  }

  /**
   * Unsubscribe from a stream.
   *
   * Sends a JSON unsubscribe message to the bridge server and removes
   * the local callback registration.
   *
   * @param streamId - Numeric stream identifier to unsubscribe from
   */
  unsubscribe(streamId: number): void {
    this.callbacks.delete(streamId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', streamId }));
    }
  }

  /**
   * Close the connection and stop all reconnection attempts.
   *
   * Clears all callbacks and cancels any pending reconnect timer.
   */
  close(): void {
    this.closing = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.callbacks.clear();
    this.log.info('Closed');
  }

  /** Total bytes received across all binary messages */
  get bytesReceived(): number {
    return this._bytesReceived;
  }

  /** Total number of binary messages received */
  get messageCount(): number {
    return this._messageCount;
  }

  /** Whether the WebSocket is currently connected */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Parse a binary message according to the VMS protocol and dispatch
   * the frame to the appropriate stream callback.
   */
  private handleBinaryMessage(buffer: ArrayBuffer): void {
    this._bytesReceived += buffer.byteLength;
    this._messageCount++;

    if (buffer.byteLength < HEADER_SIZE) {
      this.log.warn(`Message too short: ${buffer.byteLength} bytes`);
      return;
    }

    const view = new DataView(buffer);
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
      this.log.warn(`Unknown protocol version: ${version}`);
      return;
    }

    const streamId = view.getUint16(1, false); // big-endian
    const timestamp = view.getBigUint64(3, false); // big-endian
    const flags = view.getUint8(11);
    const isKeyframe = (flags & 0x01) !== 0;
    const isConfig = (flags & 0x02) !== 0;
    const data = new Uint8Array(buffer, HEADER_SIZE);

    const callback = this.callbacks.get(streamId);
    if (callback) {
      callback({ streamId, timestamp, isKeyframe, isConfig, data });
    }
  }

  /** Send a JSON subscribe message over the WebSocket */
  private sendSubscribe(streamId: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', streamId }));
      this.log.info(`Subscribed to stream ${streamId}`);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * Delay doubles with each attempt up to MAX_RECONNECT_DELAY_MS.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;

    this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
