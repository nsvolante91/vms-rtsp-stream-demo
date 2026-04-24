/**
 * Stream Manager
 *
 * Manages multiple RTSP stream bridges. Each managed stream maintains
 * an RTSPClient connection and forwards H.264 NAL units to subscribed
 * WebTransport clients using a compact binary protocol.
 *
 * Uses WebTransport (HTTP/3 QUIC): per-stream unidirectional QUIC streams,
 * no head-of-line blocking, ideal for Chrome 114+. Frames are length-prefixed
 * (4-byte big-endian) since QUIC streams are byte-oriented.
 */

import { FFmpegSource, type NALUEvent } from './ffmpeg-source.js';
import { RTSPClient } from './rtsp-client.js';
import { LocalFileSource } from './local-file-source.js';
import { frameLengthPrefixed, readLengthPrefixed, writeLengthPrefixed } from './framing.js';
import {
  isKeyframe,
  isConfigNAL,
  isVCLNAL,
  isFirstSliceInPicture,
  buildAvcC,
  type SPSInfo,
} from './h264-parser.js';

/** Protocol version for the binary frame header */
const PROTOCOL_VERSION = 0x01;

/** Flag bit indicating the payload contains a keyframe */
const FLAG_KEYFRAME = 0x01;

/** Public information about a managed stream */
export interface StreamInfo {
  /** Unique stream identifier */
  id: number;
  /** Source URL or file path */
  source: string;
  /** Source type */
  sourceType: 'rtsp' | 'file';
  /** Video width in pixels (0 if SPS not yet received) */
  width: number;
  /** Video height in pixels (0 if SPS not yet received) */
  height: number;
  /** AVC codec string (empty if SPS not yet received) */
  codecString: string;
  /** Whether the stream is currently receiving data */
  active: boolean;
  /**
   * RTSP source URL.
   * @deprecated Use `source` and `sourceType` instead
   */
  rtspUrl: string;
}

/** A pending access unit being accumulated from VCL NAL units in AVCC format */
interface PendingAccessUnit {
  /** Concatenated NAL unit data with 4-byte AVCC length prefixes */
  payload: Buffer;
  /** Timestamp for this access unit */
  timestamp: bigint;
  /** Whether this AU contains a keyframe (IDR) */
  isKeyframe: boolean;
}

/** A subscriber for a specific video stream */
interface VideoSubscription {
  /** Client identifier */
  clientId: number;
  /** Send a binary protocol frame to this subscriber (fire-and-forget) */
  send: (frame: Buffer) => void;
  /** Whether this subscriber is currently backpressured */
  isBackpressured: () => boolean;
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
  source: string;
  sourceType: 'rtsp' | 'file';
  client: FFmpegSource;
  spsInfo: SPSInfo | null;
  /** Stored SPS NAL unit (no start code) for building avcC on new subscribers */
  spsNALU: Uint8Array | null;
  /** Stored PPS NAL unit (no start code) for building avcC on new subscribers */
  ppsNALU: Uint8Array | null;
  /** Precomputed avcC descriptor, rebuilt whenever SPS or PPS changes */
  avcCDescriptor: Uint8Array | null;
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
 * +---------+----------+-----------+----------+------------------+
 * | Version | StreamID | Timestamp | Flags    | Payload          |
 * | 1 byte  | 2 bytes  | 8 bytes   | 1 byte   | Variable         |
 * | (0x01)  | uint16BE | uint64BE  |          | H.264 AVCC NALUs |
 * +---------+----------+-----------+----------+------------------+
 * ```
 *
 * Payload is AVCC-formatted: each NAL unit prefixed with a 4-byte
 * big-endian length field. No Annex B start codes.
 *
 * @param streamId - Stream identifier
 * @param timestamp - Timestamp in microseconds
 * @param flags - Bitfield (bit 0 = keyframe)
 * @param payload - H.264 AVCC data
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
   * Add and connect a new stream from an RTSP URL or local file path.
   *
   * Auto-detects source type: strings starting with `rtsp://` create an
   * RTSPClient; file paths create a LocalFileSource.
   *
   * @param id - Unique stream identifier
   * @param source - RTSP URL or local file path
   * @returns Stream information (dimensions may be 0 until SPS is received)
   * @throws Error if a stream with the given ID already exists
   */
  async addStream(id: number, source: string): Promise<StreamInfo> {
    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} already exists`);
    }

    const isRtsp = source.startsWith('rtsp://');
    const client: FFmpegSource = isRtsp
      ? new RTSPClient(source)
      : new LocalFileSource(source);

    const managed: ManagedStream = {
      id,
      source,
      sourceType: isRtsp ? 'rtsp' : 'file',
      client,
      spsInfo: null,
      spsNALU: null,
      ppsNALU: null,
      avcCDescriptor: null,
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
      console.log(`[Stream ${id}] Connected to ${source} (${managed.sourceType})`);
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
        if (
          client.subscribedStreams.size === 0 &&
          client.videoWriter
        ) {
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
   * Read length-prefixed JSON control messages from a WebTransport client.
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
   * Send a JSON control message to a WebTransport client.
   *
   * @param client - Target client
   * @param message - JSON-serializable message
   */
  private async sendControlMessage(client: WTClient, message: unknown): Promise<void> {
    if (!client.connected) return;

    try {
      if (!client.controlWriter) return;
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      await writeLengthPrefixed(client.controlWriter, bytes);
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Subscribe a client to a stream.
   *
   * Opens a dedicated unidirectional QUIC stream, sends cached SPS/PPS,
   * and begins forwarding H.264 access units.
   *
   * @param client - Connected WebTransport client
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

      const writer = client.videoWriter!;
      const subscription: VideoSubscription = {
        clientId: client.id,
        send: (frame: Buffer) => {
          const prefixed = frameLengthPrefixed(frame);
          writer.write(prefixed).catch(() => {
            managed.subscribers.delete(client.id);
          });
        },
        isBackpressured: () =>
          writer.desiredSize !== null && writer.desiredSize <= 0,
      };

      client.subscribedStreams.add(streamId);
      managed.subscribers.set(client.id, subscription);

      console.log(
        `[WT] Client ${client.id} subscribed to stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );

      await this.sendControlMessage(client, {
        type: 'subscribed',
        stream: this.getStreamInfo(managed),
      });

      // Send codec config immediately if SPS+PPS are already available;
      // otherwise the client will receive it when the next SPS/PPS arrive.
      if (managed.avcCDescriptor && managed.spsInfo) {
        await this.sendStreamConfig(client.id, managed);
      }
    } catch (err) {
      console.error(
        `[WT] Failed to subscribe client ${client.id} to stream ${streamId}:`,
        err
      );
    }
  }

  /**
   * Send a JSON config control message to a client with codec parameters.
   *
   * Delivers the avcC descriptor, codec string, and video dimensions so
   * the client can configure VideoDecoder without parsing any NAL units.
   *
   * @param clientId - Target client identifier
   * @param managed - Stream with computed avcC and SPS info
   */
  private async sendStreamConfig(
    clientId: number,
    managed: ManagedStream
  ): Promise<void> {
    if (!managed.avcCDescriptor || !managed.spsInfo) return;

    const client = this.clients.get(clientId);
    if (!client || !client.connected) return;

    const avcC = Buffer.from(managed.avcCDescriptor).toString('base64');
    await this.sendControlMessage(client, {
      type: 'config',
      streamId: managed.id,
      codec: managed.spsInfo.codecString,
      codedWidth: managed.spsInfo.width,
      codedHeight: managed.spsInfo.height,
      avcC,
    });
  }

  /**
   * Unsubscribe a client from a stream.
   *
   * @param client - Connected WebTransport client
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
    if (
      client.subscribedStreams.size === 0 &&
      client.videoWriter
    ) {
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
   * Config NALs (SPS/PPS) update the stored parameters and broadcast
   * an updated JSON config message to all current subscribers via the
   * control channel. VCL NALs are accumulated into AVCC-format access units.
   *
   * @param managed - Source stream
   * @param event - NAL unit event to handle
   */
  private handleNALU(managed: ManagedStream, event: NALUEvent): void {
    if (isConfigNAL(event.type)) {
      if (event.type === 7) {
        managed.spsNALU = new Uint8Array(event.nalUnit);
      } else {
        managed.ppsNALU = new Uint8Array(event.nalUnit);
      }

      // Recompute avcC whenever both SPS and PPS are available
      if (managed.spsNALU && managed.ppsNALU && managed.spsInfo) {
        managed.avcCDescriptor = buildAvcC(
          managed.spsNALU,
          managed.ppsNALU,
          managed.spsInfo
        );
        // Broadcast updated config to existing subscribers
        for (const [clientId] of managed.subscribers) {
          this.sendStreamConfig(clientId, managed).catch(() => {});
        }
      }
      return;
    }

    if (!isVCLNAL(event.type)) return;

    // Build AVCC: 4-byte big-endian length prefix followed by raw NALU bytes
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(event.nalUnit.length, 0);
    const naluBuf = Buffer.concat([lenBuf, event.nalUnit]);

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
   * The payload is already in AVCC format (4-byte length-prefixed NALUs),
   * assembled incrementally in handleNALU.
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
    for (const [clientId, sub] of managed.subscribers) {
      const client = this.clients.get(clientId);
      if (!client || !client.connected) {
        managed.subscribers.delete(clientId);
        continue;
      }

      // Backpressure: skip non-keyframes when subscriber is saturated
      if (!isKeyframe && sub.isBackpressured()) {
        continue;
      }

      sub.send(frame);
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
      source: managed.source,
      sourceType: managed.sourceType,
      rtspUrl: managed.source,
      width: managed.spsInfo?.width ?? 0,
      height: managed.spsInfo?.height ?? 0,
      codecString: managed.spsInfo?.codecString ?? '',
      active: managed.client.isRunning(),
    };
  }
}
