/**
 * WebTransport receiver for the VMS RTP streaming protocol.
 *
 * Connects to the bridge server over HTTP/3 WebTransport, using a single
 * QUIC connection with multiplexed streams:
 * - One bidirectional stream for control (subscribe/unsubscribe JSON messages)
 * - One server→client unidirectional stream for video data (raw RTP packets)
 *
 * The server forwards raw RTP packets with a 2-byte stream ID prefix.
 * Messages on all streams use 4-byte big-endian length-prefix framing
 * since QUIC streams are byte-oriented.
 *
 * Codec configuration (SPS/PPS) is received via JSON control messages
 * from the server when subscribing to a stream.
 */

import { Logger } from '../utils/logger';

/** Codec configuration received from the server via SDP/control channel */
export interface CodecConfig {
  /** Stream ID this config belongs to */
  streamId: number;
  /** Base64-encoded SPS NAL unit */
  spsB64: string;
  /** Base64-encoded PPS NAL unit */
  ppsB64: string;
  /** AVC codec string (e.g., "avc1.640028") */
  codecString: string;
  /** Video width from SPS */
  width: number;
  /** Video height from SPS */
  height: number;
  /** RTP payload type number */
  payloadType: number;
  /** RTP clock rate (typically 90000) */
  clockRate: number;
}

/** A received RTP packet with stream identification */
export interface ReceivedRTPPacket {
  /** Numeric stream identifier */
  streamId: number;
  /** Raw RTP packet bytes (including RTP header) */
  packet: Uint8Array;
}

/** Callback invoked when an RTP packet is received for a subscribed stream */
export type RTPPacketCallback = (packet: ReceivedRTPPacket) => void;

/** Callback invoked when codec configuration is received for a stream */
export type CodecConfigCallback = (config: CodecConfig) => void;

/** Maximum reconnection delay in milliseconds */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Base reconnection delay in milliseconds */
const BASE_RECONNECT_DELAY_MS = 1_000;

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

/** BYOB read buffer size (32 KB) */
const BYOB_READ_BUFFER_SIZE = 32_768;

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
 * Tries BYOB reader to eliminate browser-side per-read allocation.
 * Falls back to default reader if BYOB is unsupported.
 */
async function* readLengthPrefixed(
  readable: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  let byobReader: ReadableStreamBYOBReader | null = null;
  let defaultReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    byobReader = readable.getReader({ mode: 'byob' });
  } catch {
    defaultReader = readable.getReader();
  }

  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(ACCUM_BUFFER_INITIAL_SIZE);
  let filled = 0;
  let readBuf: ArrayBuffer | null = byobReader ? new ArrayBuffer(BYOB_READ_BUFFER_SIZE) : null;

  async function readMore(): Promise<boolean> {
    if (byobReader) {
      const view = new Uint8Array(readBuf!, 0, readBuf!.byteLength);
      const result = await byobReader.read(view);
      if (result.done) return false;
      readBuf = result.value.buffer;
      const bytesRead = result.value.byteLength;
      if (filled + bytesRead > buf.byteLength) {
        buf = growBuffer(buf, filled, filled + bytesRead);
      }
      buf.set(new Uint8Array(readBuf!, result.value.byteOffset, bytesRead), filled);
      filled += bytesRead;
    } else {
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
      while (filled < 4) {
        if (!(await readMore())) return;
      }

      const length =
        ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
      const totalNeeded = 4 + length;

      if (totalNeeded > buf.byteLength) {
        buf = growBuffer(buf, filled, totalNeeded);
      }

      while (filled < totalNeeded) {
        if (!(await readMore())) return;
      }

      yield buf.slice(4, totalNeeded);

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
 * raw RTP packets to registered stream callbacks.
 *
 * Uses a single QUIC connection with multiplexed streams:
 * - Bidirectional stream #0 = control channel (JSON subscribe/unsubscribe)
 * - Unidirectional server→client stream for video RTP packets
 *
 * Codec configuration is received as JSON on the control channel.
 */
export class WTReceiver {
  private transport: WebTransport | null = null;
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly rtpCallbacks: Map<number, RTPPacketCallback> = new Map();
  private readonly configCallbacks: Map<number, CodecConfigCallback> = new Map();
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
   * @param wtUrl - WebTransport server URL
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
   */
  async connect(): Promise<void> {
    this.closing = false;

    if (this.transport) {
      this.log.warn('Already connected or connecting');
      return;
    }

    try {
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

      // Read control messages from server
      this.readControlMessages(controlStream.readable).catch((err) => {
        this.log.error('Control channel read error', err);
      });

      // Re-subscribe to any previously registered streams
      for (const streamId of this.rtpCallbacks.keys()) {
        await this.sendSubscribe(streamId);
      }

      // Start accepting incoming unidirectional streams (RTP data)
      this.acceptVideoStreams().catch((err) => {
        if (!this.closing) {
          this.log.error('Video stream acceptor error', err);
        }
      });
    } catch (err) {
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
   * Subscribe to a stream's RTP packets and register callbacks.
   *
   * @param streamId - Numeric stream identifier
   * @param rtpCallback - Function invoked for each received RTP packet
   * @param configCallback - Function invoked when codec config is received
   */
  subscribe(
    streamId: number,
    rtpCallback: RTPPacketCallback,
    configCallback?: CodecConfigCallback
  ): void {
    this.rtpCallbacks.set(streamId, rtpCallback);
    if (configCallback) {
      this.configCallbacks.set(streamId, configCallback);
    }
    if (this.controlWriter) {
      this.sendSubscribe(streamId).catch((err) => {
        this.log.error(`Failed to subscribe to stream ${streamId}`, err);
      });
    }
  }

  /**
   * Unsubscribe from a stream.
   */
  unsubscribe(streamId: number): void {
    this.rtpCallbacks.delete(streamId);
    this.configCallbacks.delete(streamId);
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
    this.rtpCallbacks.clear();
    this.configCallbacks.clear();
    this.log.info('Closed');
  }

  /** Total bytes received across all video streams */
  get bytesReceived(): number {
    return this._bytesReceived;
  }

  /** Total number of messages received */
  get messageCount(): number {
    return this._messageCount;
  }

  /** Whether the WebTransport session is currently active */
  get connected(): boolean {
    return this.transport !== null;
  }

  /**
   * Accept incoming unidirectional streams from the server.
   */
  private async acceptVideoStreams(): Promise<void> {
    if (!this.transport) return;

    const reader = this.transport.incomingUnidirectionalStreams.getReader();

    try {
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;

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
   * Read length-prefixed messages from a unidirectional video stream.
   *
   * Each message is: [2-byte stream ID BE][raw RTP packet]
   */
  private async processVideoStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    for await (const frameBytes of readLengthPrefixed(readable)) {
      this._bytesReceived += frameBytes.byteLength;
      this._messageCount++;

      this.parseRTPMessage(frameBytes);
    }
  }

  /**
   * Parse a received message and dispatch the RTP packet to the callback.
   *
   * Wire format: [2-byte stream ID BE][raw RTP packet]
   */
  private parseRTPMessage(buffer: Uint8Array): void {
    if (buffer.byteLength < 14) {
      // 2 bytes stream ID + minimum 12 bytes RTP header
      this.log.warn(`Message too short: ${buffer.byteLength} bytes`);
      return;
    }

    const streamId = (buffer[0] << 8) | buffer[1];
    const rtpPacket = buffer.subarray(2);

    const callback = this.rtpCallbacks.get(streamId);
    if (callback) {
      callback({ streamId, packet: rtpPacket });
    }
  }

  /**
   * Read JSON control messages from the server.
   *
   * Handles codec-config messages by dispatching to registered callbacks.
   */
  private async readControlMessages(readable: ReadableStream<Uint8Array>): Promise<void> {
    for await (const msgBytes of readLengthPrefixed(readable)) {
      try {
        const text = new TextDecoder().decode(msgBytes);
        const msg = JSON.parse(text);
        this.log.info(`Control message: ${msg.type}`);

        if (msg.type === 'codec-config') {
          const config: CodecConfig = {
            streamId: msg.streamId,
            spsB64: msg.spsB64,
            ppsB64: msg.ppsB64,
            codecString: msg.codecString,
            width: msg.width,
            height: msg.height,
            payloadType: msg.payloadType,
            clockRate: msg.clockRate,
          };
          const cb = this.configCallbacks.get(config.streamId);
          if (cb) {
            cb(config);
          }
        }
      } catch {
        this.log.warn('Invalid control message from server');
      }
    }
  }

  /**
   * Send a subscribe message over the control channel.
   */
  private async sendSubscribe(streamId: number): Promise<void> {
    await this.sendControlMessage({ type: 'subscribe', streamId });
    this.log.info(`Subscribed to stream ${streamId}`);
  }

  /**
   * Send a JSON message on the control bidirectional stream.
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
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = null;
      this.certHash = null;
      this.connect();
    }, delay);
  }
}
