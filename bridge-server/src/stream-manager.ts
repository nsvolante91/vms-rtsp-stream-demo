/**
 * Stream Manager — WebTransport + WebSocket Edition
 *
 * Manages multiple RTSP stream bridges. Each managed stream maintains
 * an RTSPClient connection and forwards H.264 NAL units to subscribed
 * clients using a compact binary protocol.
 *
 * Supports two transport layers:
 * - **WebTransport** (primary): Per-stream QUIC unidirectional streams,
 *   no head-of-line blocking, ideal for Chrome 114+.
 * - **WebSocket** (fallback): Single TCP connection with binary frames,
 *   compatible with Safari, Firefox, and older browsers.
 *
 * Both transports use the same 12-byte binary frame header. WebTransport
 * frames are length-prefixed (byte-oriented QUIC streams), while
 * WebSocket frames are sent raw (native message boundaries).
 */

import { WebSocket as WSSocket } from 'ws';
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

/** Annex B 4-byte start code — shared constant to avoid per-NALU allocation */
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/** Cached TextEncoder/TextDecoder for control messages */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

/** Metadata for a pending access unit being accumulated from VCL NAL units */
interface PendingAccessUnit {
  /** Timestamp for this access unit */
  timestamp: bigint;
  /** Whether this AU contains a keyframe (IDR) */
  isKeyframe: boolean;
}

/** A transport-agnostic subscriber for a specific video stream */
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
  /** Transport type discriminant */
  type: 'webtransport';
  /** Unique client identifier */
  id: number;
  /** The WebTransport session */
  session: any;
  /** Writer for the control bidirectional stream */
  controlWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  /**
   * Per-stream video writers. Each subscribed streamId gets its own
   * QUIC unidirectional stream to eliminate head-of-line blocking
   * between different video feeds.
   */
  videoWriters: Map<number, WritableStreamDefaultWriter<Uint8Array>>;
  /** Set of subscribed stream IDs */
  subscribedStreams: Set<number>;
  /** Whether the client is still connected */
  connected: boolean;
}

/** State for a connected WebSocket fallback client */
interface WSClient {
  /** Transport type discriminant */
  type: 'websocket';
  /** Unique client identifier */
  id: number;
  /** The WebSocket connection */
  ws: WSSocket;
  /** Set of subscribed stream IDs */
  subscribedStreams: Set<number>;
  /** Whether the client is still connected */
  connected: boolean;
}

/** Union of all supported transport client types */
type BridgeClient = WTClient | WSClient;

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
  /** Pending access unit metadata (null = no pending AU) */
  pendingAU: PendingAccessUnit | null;
  /** Reusable buffer for AU assembly — avoids per-frame concat allocation */
  auBuffer: Buffer;
  /** Current write position in auBuffer */
  auFilled: number;
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
  const frame = Buffer.allocUnsafe(12 + payload.length);
  frame[0] = PROTOCOL_VERSION;
  frame.writeUInt16BE(streamId, 1);
  frame.writeBigUInt64BE(timestamp, 3);
  frame[11] = flags;
  frame.set(payload, 12);
  return frame;
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
  private readonly clients: Map<number, BridgeClient> = new Map();

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
      auBuffer: Buffer.allocUnsafe(128 * 1024),
      auFilled: 0,
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
    managed.auFilled = 0;
    managed.client.close();

    for (const [clientId] of managed.subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        client.subscribedStreams.delete(id);
        // For WT: close the per-stream video writer
        if (client.type === 'webtransport') {
          const writer = client.videoWriters.get(id);
          if (writer) {
            try {
              writer.close().catch(() => {});
            } catch {
              // Already closed
            }
            client.videoWriters.delete(id);
          }
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
      type: 'webtransport',
      id: clientId,
      session,
      controlWriter: null,
      videoWriters: new Map(),
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
        if (client.type === 'webtransport') {
          client.session.close({ closeCode: 0, reason: 'Server shutting down' });
        } else {
          client.ws.close(1001, 'Server shutting down');
        }
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
  }

  /**
   * Handle a new WebSocket client connection.
   *
   * Provides the same subscribe/unsubscribe semantics as WebTransport
   * sessions but over a single WebSocket connection. Binary frames are
   * sent directly without length-prefix framing since WebSocket provides
   * native message boundaries.
   *
   * @param ws - WebSocket connection from the ws library
   */
  handleWebSocketClient(ws: WSSocket): void {
    const clientId = nextClientId++;

    const client: WSClient = {
      type: 'websocket',
      id: clientId,
      ws,
      subscribedStreams: new Set(),
      connected: true,
    };

    this.clients.set(clientId, client);
    console.log(`[WS] Client ${clientId} connected`);

    // Send available streams list
    this.sendControlMessage(client, {
      type: 'streams',
      streams: this.getStreams(),
    }).catch(() => {});

    ws.on('message', (data: Buffer | string) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        const parsed = JSON.parse(text) as ClientMessage;

        if (parsed.type === 'subscribe') {
          this.subscribeClient(client, parsed.streamId).catch((err) => {
            console.error(`[WS] Client ${clientId} subscribe error:`, err);
          });
        } else if (parsed.type === 'unsubscribe') {
          this.unsubscribeClient(client, parsed.streamId);
        }
      } catch (err) {
        console.warn(`[WS] Client ${clientId} invalid message:`, err);
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnect(clientId);
    });

    ws.on('error', (err: Error) => {
      console.error(`[WS] Client ${clientId} error:`, err.message);
    });
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
        const text = textDecoder.decode(msgBytes);
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
   * Send a JSON control message to a client (transport-agnostic).
   *
   * For WebTransport: length-prefixed write on the control bidirectional stream.
   * For WebSocket: JSON text message.
   *
   * @param client - Target client
   * @param message - JSON-serializable message
   */
  private async sendControlMessage(client: BridgeClient, message: unknown): Promise<void> {
    if (!client.connected) return;

    try {
      if (client.type === 'webtransport') {
        if (!client.controlWriter) return;
        const bytes = textEncoder.encode(JSON.stringify(message));
        await writeLengthPrefixed(client.controlWriter, bytes);
      } else {
        if (client.ws.readyState === WSSocket.OPEN) {
          client.ws.send(JSON.stringify(message));
        }
      }
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Subscribe a client to a stream.
   *
   * Creates a transport-appropriate video subscription, sends cached
   * SPS/PPS, and begins forwarding H.264 access units.
   *
   * For WebTransport: opens a dedicated unidirectional QUIC stream.
   * For WebSocket: sends binary frames directly on the WS connection.
   *
   * @param client - Connected client (WT or WS)
   * @param streamId - Stream to subscribe to
   */
  private async subscribeClient(client: BridgeClient, streamId: number): Promise<void> {
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
      let subscription: VideoSubscription;

      if (client.type === 'webtransport') {
        // Create a dedicated QUIC unidirectional stream for this subscription.
        // Each stream gets independent flow control, eliminating head-of-line
        // blocking between different video feeds.
        const sendStream = await client.session.createUnidirectionalStream();
        const writer = sendStream.getWriter();
        client.videoWriters.set(streamId, writer);
        console.log(`[WT] Client ${client.id} video stream opened for stream ${streamId}`);

        subscription = {
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
      } else {
        // WebSocket: send raw binary frames (WS has message boundaries)
        const ws = client.ws;
        subscription = {
          clientId: client.id,
          send: (frame: Buffer) => {
            if (ws.readyState === WSSocket.OPEN) {
              ws.send(frame);
            }
          },
          isBackpressured: () => ws.bufferedAmount > 256 * 1024,
        };
      }

      client.subscribedStreams.add(streamId);
      managed.subscribers.set(client.id, subscription);

      // Resume FFmpeg stdout if this is the first subscriber
      if (managed.subscribers.size === 1) {
        managed.client.resume();
      }

      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.log(
        `[${tag}] Client ${client.id} subscribed to stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );

      await this.sendControlMessage(client, {
        type: 'subscribed',
        stream: this.getStreamInfo(managed),
      });

      this.sendConfigToSubscriber(subscription, managed);
    } catch (err) {
      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.error(
        `[${tag}] Failed to subscribe client ${client.id} to stream ${streamId}:`,
        err
      );
    }
  }

  /**
   * Send cached SPS and PPS NAL units to a subscriber.
   *
   * Uses the subscriber's transport-agnostic `send` callback so
   * it works for both WebTransport and WebSocket clients.
   *
   * @param sub - Target video subscription
   * @param managed - Stream with cached config data
   */
  private sendConfigToSubscriber(
    sub: VideoSubscription,
    managed: ManagedStream
  ): void {
    if (!managed.spsNALU || !managed.ppsNALU) return;

    // Send SPS and PPS as separate CONFIG frames (matching handleNALU behavior).
    // Combining them into one Annex B frame with start codes causes re-parsing
    // ambiguity: the client's 3-byte start code scanner would absorb a trailing
    // zero from the SPS into the next start code boundary.
    const spsPayload = Buffer.concat([START_CODE, managed.spsNALU]);
    const spsFrame = buildFrame(managed.id, 0n, FLAG_CONFIG, spsPayload);
    sub.send(spsFrame);

    const ppsPayload = Buffer.concat([START_CODE, managed.ppsNALU]);
    const ppsFrame = buildFrame(managed.id, 0n, FLAG_CONFIG, ppsPayload);
    sub.send(ppsFrame);
  }

  /**
   * Unsubscribe a client from a stream.
   *
   * @param client - Connected client (WT or WS)
   * @param streamId - Stream to unsubscribe from
   */
  private unsubscribeClient(client: BridgeClient, streamId: number): void {
    const managed = this.streams.get(streamId);
    if (managed) {
      managed.subscribers.delete(client.id);

      // Pause FFmpeg stdout when last subscriber disconnects
      if (managed.subscribers.size === 0) {
        managed.client.pause();
      }

      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.log(
        `[${tag}] Client ${client.id} unsubscribed from stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );
    }

    client.subscribedStreams.delete(streamId);

    // For WT: close the per-stream video writer
    if (client.type === 'webtransport') {
      const writer = client.videoWriters.get(streamId);
      if (writer) {
        try {
          writer.close().catch(() => {});
        } catch {
          // Already closed
        }
        client.videoWriters.delete(streamId);
      }
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
        // Pause FFmpeg stdout when last subscriber disconnects
        if (managed.subscribers.size === 0) {
          managed.client.pause();
        }
      }
    }
    client.subscribedStreams.clear();

    if (client.type === 'webtransport') {
      // Close all per-stream video writers
      for (const writer of client.videoWriters.values()) {
        try {
          writer.close().catch(() => {});
        } catch {
          // Already closed
        }
      }
      client.videoWriters.clear();

      if (client.controlWriter) {
        try {
          client.controlWriter.close().catch(() => {});
        } catch {
          // Already closed
        }
      }
    }
    // WS clients: socket cleanup is handled by ws 'close' event

    this.clients.delete(clientId);
    const tag = client.type === 'webtransport' ? 'WT' : 'WS';
    console.log(`[${tag}] Client ${clientId} disconnected`);
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

      const payload = Buffer.concat([START_CODE, event.nalUnit]);
      const frame = buildFrame(managed.id, event.timestamp, FLAG_CONFIG, payload);
      this.sendToSubscribers(managed, frame, false);
      return;
    }

    if (!isVCLNAL(event.type)) return;

    if (isFirstSliceInPicture(event.nalUnit)) {
      this.flushAccessUnit(managed);
      managed.pendingAU = {
        timestamp: event.timestamp,
        isKeyframe: event.isKeyframe,
      };
      managed.auFilled = 0;
      this.appendToAUBuffer(managed, event.nalUnit);
    } else if (managed.pendingAU) {
      this.appendToAUBuffer(managed, event.nalUnit);
      if (event.isKeyframe) {
        managed.pendingAU.isKeyframe = true;
      }
    }
  }

  /**
   * Append a NAL unit (with start code prefix) to the stream's AU buffer.
   * Grows the buffer by doubling if needed.
   */
  private appendToAUBuffer(managed: ManagedStream, nalUnit: Uint8Array): void {
    const needed = managed.auFilled + 4 + nalUnit.length;
    if (needed > managed.auBuffer.length) {
      const newBuf = Buffer.allocUnsafe(Math.max(managed.auBuffer.length * 2, needed));
      if (managed.auFilled > 0) {
        managed.auBuffer.copy(newBuf, 0, 0, managed.auFilled);
      }
      managed.auBuffer = newBuf;
    }
    managed.auBuffer.set(START_CODE, managed.auFilled);
    managed.auFilled += 4;
    managed.auBuffer.set(nalUnit, managed.auFilled);
    managed.auFilled += nalUnit.length;
  }

  /**
   * Flush the pending access unit to all subscribers.
   *
   * @param managed - Stream with pending access unit to flush
   */
  private flushAccessUnit(managed: ManagedStream): void {
    const au = managed.pendingAU;
    managed.pendingAU = null;

    if (!au || managed.auFilled === 0 || managed.subscribers.size === 0) return;

    let flags = 0;
    if (au.isKeyframe) {
      flags |= FLAG_KEYFRAME;
    }

    // Use subarray view — buildFrame copies the payload into a new frame buffer
    const payload = managed.auBuffer.subarray(0, managed.auFilled);
    const frame = buildFrame(managed.id, au.timestamp, flags, payload);
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
      rtspUrl: managed.rtspUrl,
      width: managed.spsInfo?.width ?? 0,
      height: managed.spsInfo?.height ?? 0,
      codecString: managed.spsInfo?.codecString ?? '',
      active: managed.client.isRunning(),
    };
  }
}
