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

/** Expected concurrent video streams for QUIC flow control pre-allocation */
const ANTICIPATED_CONCURRENT_STREAMS = 32;

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

/** Accumulation buffer initial size (64 KB) */
const ACCUM_BUFFER_INITIAL_SIZE = 65_536;

/** BYOB read buffer initial size (32 KB) — recycled by browser on each read */
const BYOB_READ_BUFFER_INITIAL_SIZE = 32_768;

/** Maximum BYOB read buffer size (256 KB) — cap to prevent unbounded growth */
const BYOB_READ_BUFFER_MAX_SIZE = 262_144;

/**
 * P99 frame size tracker for BYOB buffer pre-sizing.
 * Tracks the 99th percentile frame size over a rolling window
 * so the BYOB read buffer can be pre-sized to avoid reallocations.
 */
class FrameSizeTracker {
  private readonly sizes: number[] = [];
  private readonly maxSamples = 1000;
  private _p99Size = BYOB_READ_BUFFER_INITIAL_SIZE;

  /** Record a frame size and update P99 */
  record(size: number): void {
    this.sizes.push(size);
    if (this.sizes.length > this.maxSamples) {
      this.sizes.shift();
    }
    // Recalculate P99 every 100 frames
    if (this.sizes.length % 100 === 0 && this.sizes.length >= 100) {
      const sorted = [...this.sizes].sort((a, b) => a - b);
      const idx = Math.floor(sorted.length * 0.99);
      this._p99Size = Math.min(sorted[idx], BYOB_READ_BUFFER_MAX_SIZE);
    }
  }

  /** Current P99 frame size */
  get p99Size(): number {
    return this._p99Size;
  }
}

/**
 * Grow a Uint8Array buffer while preserving existing data.
 */
function growBuffer(buf: Uint8Array, filled: number, minCapacity: number): Uint8Array {
  const newSize = Math.max(buf.byteLength * 2, minCapacity);
  const newBuf = new Uint8Array(newSize);
  if (filled > 0) {
    newBuf.set(buf.subarray(0, filled));
  }
  return newBuf;
}

/**
 * Async generator that reads length-prefixed messages from a ReadableStream.
 *
 * Tries BYOB reader to eliminate browser-side per-read Uint8Array allocation.
 * BYOB uses a separate small read buffer (recycled via ownership transfer)
 * and copies into a stable accumulation buffer. Falls back to default reader
 * if the stream doesn't support BYOB mode.
 *
 * The accumulation buffer uses doubling growth + copyWithin compaction to
 * avoid the O(N²) concat+slice pattern.
 */
async function* readLengthPrefixed(
  readable: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  // Try BYOB reader; fall back to default reader
  let byobReader: ReadableStreamBYOBReader | null = null;
  let defaultReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    byobReader = readable.getReader({ mode: 'byob' });
  } catch {
    defaultReader = readable.getReader();
  }

  // Stable accumulation buffer — never transferred to BYOB
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(ACCUM_BUFFER_INITIAL_SIZE);
  let filled = 0;

  // P99 frame size tracker for adaptive BYOB buffer sizing
  const sizeTracker = new FrameSizeTracker();

  // Separate BYOB read buffer — ownership is transferred to/from the browser
  // on each read call, eliminating browser-side allocation. Size adapts to P99.
  let readBufSize = byobReader ? BYOB_READ_BUFFER_INITIAL_SIZE : 0;
  let readBuf: ArrayBuffer | null = byobReader ? new ArrayBuffer(readBufSize) : null;

  /**
   * Read more data into the accumulation buffer.
   * Returns false when the stream ends.
   */
  async function readMore(): Promise<boolean> {
    if (byobReader) {
      // BYOB: read into the separate recycled buffer, then copy to accum
      const view = new Uint8Array(readBuf!, 0, readBuf!.byteLength);
      const result = await byobReader.read(view);
      if (result.done) return false;
      // The browser transfers the buffer back — recycle it for next read
      readBuf = result.value.buffer;
      const bytesRead = result.value.byteLength;
      if (filled + bytesRead > buf.byteLength) {
        buf = growBuffer(buf, filled, filled + bytesRead);
      }
      buf.set(new Uint8Array(readBuf!, result.value.byteOffset, bytesRead), filled);
      filled += bytesRead;
    } else {
      // Default reader: copy chunk into accum buffer
      const { value, done } = await defaultReader!.read();
      if (done || !value) return false;
      if (filled + value.byteLength > buf.byteLength) {
        buf = growBuffer(buf, filled, filled + value.byteLength);
      }
      buf.set(value, filled);
      filled += value.byteLength;
    }
    return true;
  }

  try {
    while (true) {
      // Accumulate until we have the 4-byte length prefix
      while (filled < 4) {
        if (!(await readMore())) return;
      }

      const length =
        ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
      const totalNeeded = 4 + length;

      // Pre-grow if the message exceeds current buffer capacity
      if (totalNeeded > buf.byteLength) {
        buf = growBuffer(buf, filled, totalNeeded);
      }

      // Accumulate until we have the complete message
      while (filled < totalNeeded) {
        if (!(await readMore())) return;
      }

      // Yield a zero-copy view — safe because parseBinaryFrame consumes it
      // synchronously via the pooled frame, and downstream EncodedVideoChunk
      // constructor copies the data internally.
      yield buf.subarray(4, totalNeeded);

      // Track frame size for P99 BYOB buffer pre-sizing
      sizeTracker.record(length);
      // Resize BYOB read buffer if P99 has grown beyond current size
      if (byobReader && sizeTracker.p99Size > readBufSize) {
        readBufSize = Math.min(sizeTracker.p99Size, BYOB_READ_BUFFER_MAX_SIZE);
        readBuf = new ArrayBuffer(readBufSize);
      }

      // Compact remaining data to front of buffer
      const remaining = filled - totalNeeded;
      if (remaining > 0) {
        buf.copyWithin(0, totalNeeded, filled);
      }
      filled = remaining;
    }
  } finally {
    if (byobReader) byobReader.releaseLock();
    if (defaultReader) defaultReader.releaseLock();
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

  /** Pooled ReceivedFrame object reused across parseBinaryFrame calls */
  private readonly _pooledFrame: ReceivedFrame = {
    streamId: 0,
    timestamp: 0n,
    isKeyframe: false,
    isConfig: false,
    data: new Uint8Array(0),
  };

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
        congestionControl: 'low-latency',
        anticipatedConcurrentIncomingUnidirectionalStreams: ANTICIPATED_CONCURRENT_STREAMS,
        serverCertificateHashes: [
          {
            algorithm: 'sha-256',
            value: this.certHash.buffer as ArrayBuffer,
          },
        ],
      } as WebTransportOptions);

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
      // Log detailed WebTransportError info for debugging handshake failures
      if (err instanceof Error) {
        const details: string[] = [`message=${err.message}`];
        if ('source' in err) details.push(`source=${(err as any).source}`);
        if ('streamErrorCode' in err) details.push(`streamErrorCode=${(err as any).streamErrorCode}`);
        this.log.error(`Connection failed [${details.join(', ')}]`);
      } else {
        this.log.error('Connection failed', err);
      }
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
  /**
   * Parse a binary frame and dispatch to the appropriate callback.
   *
   * Uses manual byte reads instead of DataView to avoid per-frame
   * DataView allocation. Reuses a single ReceivedFrame object (pooled)
   * to eliminate per-frame object creation — safe because callbacks
   * consume the frame synchronously.
   *
   * @param buffer - Raw frame bytes (12-byte header + payload)
   */
  private parseBinaryFrame(buffer: Uint8Array): void {
    if (buffer.byteLength < HEADER_SIZE) {
      this.log.warn(`Frame too short: ${buffer.byteLength} bytes`);
      return;
    }

    // Uint8Array indexing already accounts for byteOffset internally,
    // so always use 0-based indices on the view.
    const version = buffer[0];
    if (version !== PROTOCOL_VERSION) {
      this.log.warn(`Unknown protocol version: ${version}`);
      return;
    }

    const streamId = (buffer[1] << 8) | buffer[2];

    // Read 64-bit timestamp as BigInt via two 32-bit halves (manual bytes)
    const hi = ((buffer[3] << 24) | (buffer[4] << 16) | (buffer[5] << 8) | buffer[6]) >>> 0;
    const lo = ((buffer[7] << 24) | (buffer[8] << 16) | (buffer[9] << 8) | buffer[10]) >>> 0;
    const timestamp = (BigInt(hi) << 32n) | BigInt(lo);

    const flags = buffer[11];
    const isKeyframe = (flags & 0x01) !== 0;
    const isConfig = (flags & 0x02) !== 0;
    const data = buffer.subarray(HEADER_SIZE);

    const callback = this.callbacks.get(streamId);
    if (callback) {
      // Reuse pooled frame object to avoid per-frame allocation.
      // Safe because callbacks process synchronously.
      this._pooledFrame.streamId = streamId;
      this._pooledFrame.timestamp = timestamp;
      this._pooledFrame.isKeyframe = isKeyframe;
      this._pooledFrame.isConfig = isConfig;
      this._pooledFrame.data = data;
      callback(this._pooledFrame);
    }
  }

  /**
   * Read JSON control messages from the server.
   *
   * @param readable - Readable side of the control bidirectional stream
   */
  /** Cached TextDecoder — avoids per-message allocation */
  private static readonly _textDecoder = new TextDecoder();

  private async readControlMessages(readable: ReadableStream<Uint8Array>): Promise<void> {
    for await (const msgBytes of readLengthPrefixed(readable)) {
      try {
        const text = WTReceiver._textDecoder.decode(msgBytes);
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
  /** Cached TextEncoder — avoids per-message allocation */
  private static readonly _textEncoder = new TextEncoder();

  private async sendControlMessage(message: unknown): Promise<void> {
    if (!this.controlWriter) return;

    const bytes = WTReceiver._textEncoder.encode(JSON.stringify(message));
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
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = null;
      // Reset cert hash to force re-fetch (cert may have been regenerated)
      this.certHash = null;
      this.connect();
    }, delay);
  }
}
