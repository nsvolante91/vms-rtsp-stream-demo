/**
 * WebTransport receiver for the VMS binary streaming protocol.
 *
 * Connects to the bridge server over HTTP/3 WebTransport, using a single
 * QUIC connection with multiplexed streams:
 * - One bidirectional stream for control (subscribe/unsubscribe JSON messages)
 * - One server→client unidirectional stream per subscribed video feed
 *
 * This eliminates head-of-line blocking between different video streams
 * that WebSocket (TCP) suffers from. Each video feed has independent
 * QUIC flow control and congestion handling.
 *
 * Messages on all streams use 4-byte big-endian length-prefix framing
 * since QUIC streams are byte-oriented (no message boundaries).
 */

import { Logger } from '../utils/logger';

/** A parsed frame received over the WebTransport binary protocol */
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
const HEADER_SIZE = 12;
const PROTOCOL_VERSION = 0x01;

/** Maximum reconnection delay in milliseconds */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Base reconnection delay in milliseconds */
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Concatenate two Uint8Arrays.
 */
function concat(a: Uint8Array, b: Uint8Array<ArrayBufferLike>): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

/**
 * Write a length-prefixed message to a WritableStreamDefaultWriter.
 */
async function writeLengthPrefixed(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  data: Uint8Array
): Promise<void> {
  const frame = new Uint8Array(4 + data.length);
  new DataView(frame.buffer).setUint32(0, data.length, false);
  frame.set(data, 4);
  await writer.write(frame);
}

/**
 * Async generator that reads length-prefixed messages from a ReadableStream.
 * Handles chunk boundaries that don't align with message boundaries.
 */
async function* readLengthPrefixed(
  readable: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = readable.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  try {
    while (true) {
      while (buffer.length < 4) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer = concat(buffer, value);
      }

      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset
      ).getUint32(0, false);

      while (buffer.length < 4 + length) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer = concat(buffer, value);
      }

      yield buffer.slice(4, 4 + length);
      buffer = buffer.slice(4 + length);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convert a hex string to a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * WebTransport receiver that connects to the bridge server and dispatches
 * H.264 frame data to registered stream callbacks.
 *
 * Uses a single QUIC connection with multiplexed streams:
 * - Bidirectional stream #0 = control channel (JSON subscribe/unsubscribe)
 * - Multiple unidirectional server→client streams for video data
 *
 * Each video stream gets its own QUIC stream, eliminating head-of-line
 * blocking between feeds and providing independent flow control.
 */
export class WTReceiver {
  private transport: WebTransport | null = null;
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly callbacks: Map<number, FrameCallback> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private _bytesReceived = 0;
  private _messageCount = 0;
  private closing = false;
  private readonly log: Logger;
  private certHash: Uint8Array | null = null;

  /**
   * Create a new WTReceiver.
   *
   * @param wtUrl - WebTransport server URL (e.g., "https://localhost:9001/streams")
   * @param certHashUrl - REST API URL for fetching the certificate hash
   */
  constructor(
    private readonly wtUrl: string,
    private readonly certHashUrl: string
  ) {
    this.log = new Logger('WTReceiver');
  }

  /**
   * Connect to the WebTransport server.
   *
   * Fetches the server's TLS certificate hash for pinning, establishes
   * the WebTransport session, opens the control bidirectional stream,
   * and begins accepting incoming unidirectional video streams.
   */
  async connect(): Promise<void> {
    this.closing = false;

    if (this.transport) {
      this.log.warn('Already connected or connecting');
      return;
    }

    try {
      // Fetch the certificate hash from the REST API
      if (!this.certHash) {
        this.log.info(`Fetching certificate hash from ${this.certHashUrl}`);
        const response = await fetch(this.certHashUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch cert hash: ${response.status}`);
        }
        const { hash } = (await response.json()) as { hash: string };
        this.certHash = hexToBytes(hash);
        this.log.info(`Certificate hash: ${hash.substring(0, 16)}...`);
      }

      this.log.info(`Connecting to ${this.wtUrl}`);

      this.transport = new WebTransport(this.wtUrl, {
        serverCertificateHashes: [
          {
            algorithm: 'sha-256',
            value: this.certHash.buffer as ArrayBuffer,
          },
        ],
      });

      await this.transport.ready;
      this.log.info('WebTransport session established');
      this.reconnectAttempt = 0;

      // Monitor session close
      this.transport.closed
        .then(() => {
          this.log.warn('WebTransport session closed');
          this.transport = null;
          this.controlWriter = null;
          if (!this.closing) {
            this.scheduleReconnect();
          }
        })
        .catch((err) => {
          this.log.error('WebTransport session error', err);
          this.transport = null;
          this.controlWriter = null;
          if (!this.closing) {
            this.scheduleReconnect();
          }
        });

      // Open the control bidirectional stream
      const controlStream = await this.transport.createBidirectionalStream();
      this.controlWriter = controlStream.writable.getWriter();

      // Read control messages from server (stream list, subscription confirmations)
      this.readControlMessages(controlStream.readable).catch((err) => {
        this.log.error('Control channel read error', err);
      });

      // Re-subscribe to any previously registered streams
      for (const streamId of this.callbacks.keys()) {
        await this.sendSubscribe(streamId);
      }

      // Start accepting incoming unidirectional streams (video data)
      this.acceptVideoStreams().catch((err) => {
        if (!this.closing) {
          this.log.error('Video stream acceptor error', err);
        }
      });
    } catch (err) {
      this.log.error('Connection failed', err);
      this.transport = null;
      this.controlWriter = null;
      if (!this.closing) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Subscribe to a stream and register a frame callback.
   *
   * @param streamId - Numeric stream identifier
   * @param callback - Function invoked for each received frame
   */
  subscribe(streamId: number, callback: FrameCallback): void {
    this.callbacks.set(streamId, callback);
    if (this.controlWriter) {
      this.sendSubscribe(streamId).catch((err) => {
        this.log.error(`Failed to subscribe to stream ${streamId}`, err);
      });
    }
  }

  /**
   * Unsubscribe from a stream.
   *
   * @param streamId - Numeric stream identifier to unsubscribe from
   */
  unsubscribe(streamId: number): void {
    this.callbacks.delete(streamId);
    if (this.controlWriter) {
      this.sendControlMessage({ type: 'unsubscribe', streamId }).catch(() => {});
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
    if (this.controlWriter) {
      try {
        this.controlWriter.close().catch(() => {});
      } catch {
        // Already closed
      }
      this.controlWriter = null;
    }
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // Already closed
      }
      this.transport = null;
    }
    this.callbacks.clear();
    this.log.info('Closed');
  }

  /** Total bytes received across all video streams */
  get bytesReceived(): number {
    return this._bytesReceived;
  }

  /** Total number of binary frames received */
  get messageCount(): number {
    return this._messageCount;
  }

  /** Whether the WebTransport session is currently active */
  get connected(): boolean {
    return this.transport !== null;
  }

  /**
   * Accept incoming unidirectional streams from the server (video data).
   *
   * Each stream carries length-prefixed binary frames for a specific
   * video subscription. Frames are parsed and dispatched to the
   * appropriate per-stream callback.
   */
  private async acceptVideoStreams(): Promise<void> {
    if (!this.transport) return;

    const reader = this.transport.incomingUnidirectionalStreams.getReader();

    try {
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;

        // Process each video stream independently (don't block the accept loop)
        this.processVideoStream(stream).catch((err) => {
          if (!this.closing) {
            this.log.warn('Video stream read error', err);
          }
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Read length-prefixed binary frames from a single unidirectional video stream.
   *
   * @param readable - ReadableStream from a server→client unidirectional QUIC stream
   */
  private async processVideoStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    for await (const frameBytes of readLengthPrefixed(readable)) {
      this._bytesReceived += frameBytes.byteLength;
      this._messageCount++;

      this.parseBinaryFrame(frameBytes);
    }
  }

  /**
   * Parse a binary frame and dispatch to the appropriate callback.
   *
   * @param buffer - Raw frame bytes (12-byte header + payload)
   */
  private parseBinaryFrame(buffer: Uint8Array): void {
    if (buffer.byteLength < HEADER_SIZE) {
      this.log.warn(`Frame too short: ${buffer.byteLength} bytes`);
      return;
    }

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
      this.log.warn(`Unknown protocol version: ${version}`);
      return;
    }

    const streamId = view.getUint16(1, false);
    const timestamp = view.getBigUint64(3, false);
    const flags = view.getUint8(11);
    const isKeyframe = (flags & 0x01) !== 0;
    const isConfig = (flags & 0x02) !== 0;
    const data = buffer.subarray(HEADER_SIZE);

    const callback = this.callbacks.get(streamId);
    if (callback) {
      callback({ streamId, timestamp, isKeyframe, isConfig, data });
    }
  }

  /**
   * Read JSON control messages from the server.
   *
   * @param readable - Readable side of the control bidirectional stream
   */
  private async readControlMessages(readable: ReadableStream<Uint8Array>): Promise<void> {
    for await (const msgBytes of readLengthPrefixed(readable)) {
      try {
        const text = new TextDecoder().decode(msgBytes);
        const msg = JSON.parse(text);
        this.log.info(`Control message: ${msg.type}`);
      } catch {
        this.log.warn('Invalid control message from server');
      }
    }
  }

  /**
   * Send a subscribe message over the control channel.
   *
   * @param streamId - Stream to subscribe to
   */
  private async sendSubscribe(streamId: number): Promise<void> {
    await this.sendControlMessage({ type: 'subscribe', streamId });
    this.log.info(`Subscribed to stream ${streamId}`);
  }

  /**
   * Send a JSON message on the control bidirectional stream.
   *
   * @param message - JSON-serializable message
   */
  private async sendControlMessage(message: unknown): Promise<void> {
    if (!this.controlWriter) return;

    const bytes = new TextEncoder().encode(JSON.stringify(message));
    await writeLengthPrefixed(this.controlWriter, bytes);
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;

    this.log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      // Reset cert hash to force re-fetch (cert may have been regenerated)
      this.certHash = null;
      this.connect();
    }, delay);
  }
}
