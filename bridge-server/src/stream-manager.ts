/**
 * Stream Manager — WebTransport Edition
 *
 * Manages multiple RTSP-to-WebTransport bridges. Each managed stream
 * maintains an RTSPClient connection and forwards H.264 NAL units to
 * subscribed WebTransport clients using per-stream unidirectional QUIC
 * streams with the compact binary protocol.
 *
 * Architecture:
 * - One WebTransport session per client
 * - One bidirectional stream for control (subscribe/unsubscribe JSON)
 * - One server→client unidirectional stream per video subscription
 *   (eliminates cross-stream head-of-line blocking)
 */

import { RTSPClient, type NALUEvent } from './rtsp-client.js';
import { frameLengthPrefixed, readLengthPrefixed, writeLengthPrefixed } from './framing.js';
import {
  isKeyframe,
  isConfigNAL,
  isVCLNAL,
  isFirstSliceInPicture,
  type SPSInfo,
} from './h264-parser.js';

/** Protocol version for the binary frame header */
const PROTOCOL_VERSION = 0x01;

/** Flag bit indicating the payload contains a keyframe */
const FLAG_KEYFRAME = 0x01;

/** Flag bit indicating the payload contains SPS/PPS configuration */
const FLAG_CONFIG = 0x02;

/** Public information about a managed stream */
export interface StreamInfo {
  /** Unique stream identifier */
  id: number;
  /** RTSP source URL */
  rtspUrl: string;
  /** Video width in pixels (0 if SPS not yet received) */
  width: number;
  /** Video height in pixels (0 if SPS not yet received) */
  height: number;
  /** AVC codec string (empty if SPS not yet received) */
  codecString: string;
  /** Whether the stream is currently receiving data */
  active: boolean;
}

/** A pending access unit being accumulated from VCL NAL units */
interface PendingAccessUnit {
  /** Concatenated NAL unit data with Annex B start codes */
  payload: Buffer;
  /** Timestamp for this access unit */
  timestamp: bigint;
  /** Whether this AU contains a keyframe (IDR) */
  isKeyframe: boolean;
}

/** A WebTransport subscriber for a specific video stream */
interface VideoSubscription {
  /** Client identifier */
  clientId: number;
  /** Reference to the client's shared video writer */
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** State for a connected WebTransport client */
interface WTClient {
  /** Unique client identifier */
  id: number;
  /** The WebTransport session */
  session: any;
  /** Writer for the control bidirectional stream */
  controlWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  /**
   * Single shared writer for all video data (one unidirectional QUIC stream).
   *
   * We use a single uni stream instead of one-per-subscription because
   * Chrome's QUIC `initial_max_streams_uni` transport parameter is ~16,
   * and 3 are consumed by HTTP/3 internals (control, QPACK encoder/decoder),
   * leaving only ~13 for application use. The binary protocol already
   * carries streamId in each frame header so the client can demux.
   */
  videoWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  /** Set of subscribed stream IDs */
  subscribedStreams: Set<number>;
  /** Whether the client is still connected */
  connected: boolean;
}

/** Internal state for a managed stream */
interface ManagedStream {
  id: number;
  rtspUrl: string;
  client: RTSPClient;
  spsInfo: SPSInfo | null;
  /** Stored SPS NAL unit for sending to new subscribers */
  spsNALU: Uint8Array | null;
  /** Stored PPS NAL unit for sending to new subscribers */
  ppsNALU: Uint8Array | null;
  /** Map of clientId → video subscription for this stream */
  subscribers: Map<number, VideoSubscription>;
  /** Pending access unit accumulator for VCL NAL units */
  pendingAU: PendingAccessUnit | null;
}

/** Client subscribe/unsubscribe message format */
interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  streamId: number;
}

/**
 * Build a binary frame for the streaming protocol.
 *
 * Wire format:
 * ```
 * +---------+----------+-----------+----------+-------------+
 * | Version | StreamID | Timestamp | Flags    | Payload     |
 * | 1 byte  | 2 bytes  | 8 bytes   | 1 byte   | Variable    |
 * | (0x01)  | uint16BE | uint64BE  |          | H.264 NALUs |
 * +---------+----------+-----------+----------+-------------+
 * ```
 *
 * @param streamId - Stream identifier
 * @param timestamp - Timestamp in microseconds
 * @param flags - Bitfield (bit 0 = keyframe, bit 1 = config)
 * @param payload - H.264 NAL unit data
 * @returns Binary frame as Buffer
 */
function buildFrame(
  streamId: number,
  timestamp: bigint,
  flags: number,
  payload: Uint8Array
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt8(PROTOCOL_VERSION, 0);
  header.writeUInt16BE(streamId, 1);
  header.writeBigUInt64BE(timestamp, 3);
  header.writeUInt8(flags, 11);
  return Buffer.concat([header, payload]);
}

let nextClientId = 1;

/**
 * Manages multiple RTSP stream connections and distributes H.264 data
 * to subscribed WebTransport clients via per-stream unidirectional QUIC streams.
 *
 * Each stream is backed by an RTSPClient that connects to an RTSP source
 * via FFmpeg. When clients subscribe to a stream over the control channel,
 * the server opens a dedicated unidirectional stream for that subscription,
 * providing per-stream flow control and eliminating head-of-line blocking
 * between different video feeds.
 *
 * @example
 * ```typescript
 * const manager = new StreamManager();
 * await manager.addStream(1, 'rtsp://localhost:8554/stream1');
 * // When a WebTransport session connects:
 * manager.handleSession(session);
 * // Client opens bidirectional stream, sends: { "type": "subscribe", "streamId": 1 }
 * // Server opens unidirectional stream and pushes H.264 frames
 * ```
 */
export class StreamManager {
  private readonly streams: Map<number, ManagedStream> = new Map();
  private readonly clients: Map<number, WTClient> = new Map();

  /**
   * Add and connect a new RTSP stream.
   *
   * @param id - Unique stream identifier
   * @param rtspUrl - RTSP source URL
   * @returns Stream information (dimensions may be 0 until SPS is received)
   * @throws Error if a stream with the given ID already exists
   */
  async addStream(id: number, rtspUrl: string): Promise<StreamInfo> {
    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} already exists`);
    }

    const client = new RTSPClient(rtspUrl);

    const managed: ManagedStream = {
      id,
      rtspUrl,
      client,
      spsInfo: null,
      spsNALU: null,
      ppsNALU: null,
      subscribers: new Map(),
      pendingAU: null,
    };

    this.streams.set(id, managed);

    client.on('sps', (info: SPSInfo) => {
      managed.spsInfo = info;
      console.log(
        `[Stream ${id}] SPS: ${info.width}x${info.height} ${info.codecString}`
      );
    });

    client.on('nalu', (event: NALUEvent) => {
      if (event.type === 7) {
        managed.spsNALU = new Uint8Array(event.nalUnit);
      } else if (event.type === 8) {
        managed.ppsNALU = new Uint8Array(event.nalUnit);
      }
      this.handleNALU(managed, event);
    });

    client.on('error', (err: Error) => {
      console.error(`[Stream ${id}] Error: ${err.message}`);
    });

    client.on('close', () => {
      console.log(`[Stream ${id}] Connection closed`);
    });

    try {
      await client.connect();
      console.log(`[Stream ${id}] Connected to ${rtspUrl}`);
    } catch (err) {
      this.streams.delete(id);
      throw err;
    }

    return this.getStreamInfo(managed);
  }

  /**
   * Remove and disconnect a stream.
   *
   * @param id - Stream identifier to remove
   */
  removeStream(id: number): void {
    const managed = this.streams.get(id);
    if (!managed) return;

    managed.pendingAU = null;
    managed.client.close();

    for (const [clientId] of managed.subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        client.subscribedStreams.delete(id);
        // Close the shared video stream when no subscriptions remain
        if (client.subscribedStreams.size === 0 && client.videoWriter) {
          try {
            client.videoWriter.close().catch(() => {});
          } catch {
            // Already closed
          }
          client.videoWriter = null;
        }
      }
    }

    managed.subscribers.clear();
    this.streams.delete(id);
    console.log(`[Stream ${id}] Removed`);
  }

  /**
   * Handle a new WebTransport session.
   *
   * Waits for the session to be ready, reads the first incoming
   * bidirectional stream as the control channel, and processes
   * subscribe/unsubscribe commands.
   *
   * @param session - WebTransport session from the Http3Server
   */
  async handleSession(session: any): Promise<void> {
    const clientId = nextClientId++;

    const client: WTClient = {
      id: clientId,
      session,
      controlWriter: null,
      videoWriter: null,
      subscribedStreams: new Set(),
      connected: true,
    };

    this.clients.set(clientId, client);

    try {
      await session.ready;
      console.log(`[WT] Client ${clientId} session ready`);
    } catch (err) {
      console.error(`[WT] Client ${clientId} session failed:`, err);
      this.handleClientDisconnect(clientId);
      return;
    }

    // Monitor session close
    session.closed
      .then((info: any) => {
        console.log(`[WT] Client ${clientId} session closed:`, info);
        this.handleClientDisconnect(clientId);
      })
      .catch((err: any) => {
        console.error(`[WT] Client ${clientId} session close error:`, err);
        this.handleClientDisconnect(clientId);
      });

    // Read incoming bidirectional streams — first one is the control channel
    try {
      const biReader = session.incomingBidirectionalStreams.getReader();
      const { value: controlStream, done } = await biReader.read();
      biReader.releaseLock();

      if (done || !controlStream) {
        console.warn(`[WT] Client ${clientId} disconnected before control stream`);
        this.handleClientDisconnect(clientId);
        return;
      }

      client.controlWriter = controlStream.writable.getWriter();

      // Send the list of available streams on connect
      await this.sendControlMessage(client, {
        type: 'streams',
        streams: this.getStreams(),
      });

      // Process control messages
      await this.processControlMessages(client, controlStream.readable);
    } catch (err) {
      if (client.connected) {
        console.error(`[WT] Client ${clientId} control error:`, err);
        this.handleClientDisconnect(clientId);
      }
    }
  }

  /**
   * Get information about all managed streams.
   *
   * @returns Array of stream information objects
   */
  getStreams(): StreamInfo[] {
    const result: StreamInfo[] = [];
    for (const managed of this.streams.values()) {
      result.push(this.getStreamInfo(managed));
    }
    return result;
  }

  /**
   * Get the number of currently connected WebTransport clients.
   *
   * @returns Client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Shut down all streams and disconnect all clients.
   */
  shutdown(): void {
    for (const [id] of this.streams) {
      this.removeStream(id);
    }
    for (const [, client] of this.clients) {
      try {
        client.session.close({ closeCode: 0, reason: 'Server shutting down' });
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
  }

  /**
   * Read length-prefixed JSON control messages from the client.
   *
   * @param client - Client state
   * @param readable - Readable side of the control bidirectional stream
   */
  private async processControlMessages(
    client: WTClient,
    readable: ReadableStream<Uint8Array>
  ): Promise<void> {
    for await (const msgBytes of readLengthPrefixed(readable)) {
      if (!client.connected) break;

      try {
        const text = new TextDecoder().decode(msgBytes);
        const parsed = JSON.parse(text) as ClientMessage;

        if (parsed.type === 'subscribe') {
          await this.subscribeClient(client, parsed.streamId);
        } else if (parsed.type === 'unsubscribe') {
          this.unsubscribeClient(client, parsed.streamId);
        }
      } catch (err) {
        console.warn(`[WT] Client ${client.id} invalid control message:`, err);
      }
    }

    this.handleClientDisconnect(client.id);
  }

  /**
   * Send a JSON message over the control bidirectional stream.
   *
   * @param client - Target client
   * @param message - JSON-serializable message
   */
  private async sendControlMessage(client: WTClient, message: unknown): Promise<void> {
    if (!client.controlWriter || !client.connected) return;

    try {
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      await writeLengthPrefixed(client.controlWriter, bytes);
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Subscribe a client to a stream.
   *
   * Opens a dedicated server→client unidirectional stream for the video
   * feed, sends cached SPS/PPS, and begins forwarding H.264 access units.
   *
   * @param client - WebTransport client
   * @param streamId - Stream to subscribe to
   */
  private async subscribeClient(client: WTClient, streamId: number): Promise<void> {
    const managed = this.streams.get(streamId);
    if (!managed) {
      await this.sendControlMessage(client, {
        type: 'error',
        message: `Stream ${streamId} not found`,
      });
      return;
    }

    if (client.subscribedStreams.has(streamId)) {
      return;
    }

    try {
      // Create the shared video uni stream on first subscription
      if (!client.videoWriter) {
        const sendStream = await client.session.createUnidirectionalStream();
        client.videoWriter = sendStream.getWriter();
        console.log(`[WT] Client ${client.id} video stream opened`);
      }

      // Safe: guaranteed non-null by the guard above
      const writer = client.videoWriter!;

      client.subscribedStreams.add(streamId);
      managed.subscribers.set(client.id, {
        clientId: client.id,
        writer,
      });

      console.log(
        `[WT] Client ${client.id} subscribed to stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );

      await this.sendControlMessage(client, {
        type: 'subscribed',
        stream: this.getStreamInfo(managed),
      });

      await this.sendConfig(writer, managed);
    } catch (err) {
      console.error(
        `[WT] Failed to subscribe client ${client.id} to stream ${streamId}:`,
        err
      );
    }
  }

  /**
   * Send cached SPS and PPS NAL units to a client's video stream.
   *
   * @param writer - Unidirectional stream writer
   * @param managed - Stream with cached config data
   */
  private async sendConfig(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    managed: ManagedStream
  ): Promise<void> {
    if (!managed.spsNALU || !managed.ppsNALU) return;

    const startCode = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    const payload = Buffer.concat([
      startCode,
      managed.spsNALU,
      startCode,
      managed.ppsNALU,
    ]);

    const frame = buildFrame(managed.id, 0n, FLAG_CONFIG, payload);

    try {
      const prefixed = frameLengthPrefixed(frame);
      await writer.write(prefixed);
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Unsubscribe a client from a stream.
   *
   * @param client - WebTransport client
   * @param streamId - Stream to unsubscribe from
   */
  private unsubscribeClient(client: WTClient, streamId: number): void {
    const managed = this.streams.get(streamId);
    if (managed) {
      managed.subscribers.delete(client.id);
      console.log(
        `[WT] Client ${client.id} unsubscribed from stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );
    }

    client.subscribedStreams.delete(streamId);

    // Close the shared video stream when no subscriptions remain
    if (client.subscribedStreams.size === 0 && client.videoWriter) {
      try {
        client.videoWriter.close().catch(() => {});
      } catch {
        // Already closed
      }
      client.videoWriter = null;
    }
  }

  /**
   * Handle client disconnection cleanup.
   *
   * @param clientId - Disconnected client identifier
   */
  private handleClientDisconnect(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.connected = false;

    for (const streamId of client.subscribedStreams) {
      const managed = this.streams.get(streamId);
      if (managed) {
        managed.subscribers.delete(clientId);
      }
    }
    client.subscribedStreams.clear();

    if (client.videoWriter) {
      try {
        client.videoWriter.close().catch(() => {});
      } catch {
        // Already closed
      }
      client.videoWriter = null;
    }

    if (client.controlWriter) {
      try {
        client.controlWriter.close().catch(() => {});
      } catch {
        // Already closed
      }
    }

    this.clients.delete(clientId);
    console.log(`[WT] Client ${clientId} disconnected`);
  }

  /**
   * Route a NAL unit to the appropriate handler.
   *
   * @param managed - Source stream
   * @param event - NAL unit event to handle
   */
  private handleNALU(managed: ManagedStream, event: NALUEvent): void {
    if (isConfigNAL(event.type)) {
      if (managed.subscribers.size === 0) return;

      const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      const payload = Buffer.concat([startCode, event.nalUnit]);
      const frame = buildFrame(managed.id, event.timestamp, FLAG_CONFIG, payload);
      this.sendToSubscribers(managed, frame, false);
      return;
    }

    if (!isVCLNAL(event.type)) return;

    const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const naluBuf = Buffer.concat([startCode, event.nalUnit]);

    if (isFirstSliceInPicture(event.nalUnit)) {
      this.flushAccessUnit(managed);
      managed.pendingAU = {
        payload: naluBuf,
        timestamp: event.timestamp,
        isKeyframe: event.isKeyframe,
      };
    } else if (managed.pendingAU) {
      managed.pendingAU.payload = Buffer.concat([
        managed.pendingAU.payload,
        naluBuf,
      ]);
      if (event.isKeyframe) {
        managed.pendingAU.isKeyframe = true;
      }
    }
  }

  /**
   * Flush the pending access unit to all subscribers.
   *
   * @param managed - Stream with pending access unit to flush
   */
  private flushAccessUnit(managed: ManagedStream): void {
    const au = managed.pendingAU;
    managed.pendingAU = null;

    if (!au || managed.subscribers.size === 0) return;

    let flags = 0;
    if (au.isKeyframe) {
      flags |= FLAG_KEYFRAME;
    }

    const frame = buildFrame(managed.id, au.timestamp, flags, au.payload);
    this.sendToSubscribers(managed, frame, au.isKeyframe);
  }

  /**
   * Send a length-prefixed binary frame to all subscribers of a stream.
   *
   * Applies backpressure detection: non-keyframes are dropped for
   * clients whose QUIC stream write buffer is full. Keyframes are
   * always sent since they're required for decoder recovery.
   *
   * @param managed - Source stream
   * @param frame - Binary frame to send
   * @param isKeyframe - Whether this frame is an IDR keyframe
   */
  private sendToSubscribers(
    managed: ManagedStream,
    frame: Buffer,
    isKeyframe: boolean
  ): void {
    const prefixed = frameLengthPrefixed(frame);

    for (const [clientId, sub] of managed.subscribers) {
      const client = this.clients.get(clientId);
      if (!client || !client.connected) {
        managed.subscribers.delete(clientId);
        continue;
      }

      // Backpressure: skip non-keyframes when writer queue is full
      if (
        !isKeyframe &&
        sub.writer.desiredSize !== null &&
        sub.writer.desiredSize <= 0
      ) {
        continue;
      }

      sub.writer.write(prefixed).catch(() => {
        managed.subscribers.delete(clientId);
      });
    }
  }

  /**
   * Build a StreamInfo object from internal managed stream state.
   *
   * @param managed - Internal stream state
   * @returns Public stream information
   */
  private getStreamInfo(managed: ManagedStream): StreamInfo {
    return {
      id: managed.id,
      rtspUrl: managed.rtspUrl,
      width: managed.spsInfo?.width ?? 0,
      height: managed.spsInfo?.height ?? 0,
      codecString: managed.spsInfo?.codecString ?? '',
      active: managed.client.isRunning(),
    };
  }
}
