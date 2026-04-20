/**
 * Stream Manager — RTP Forwarding Edition
 *
 * Manages multiple video stream sources and forwards raw RTP packets to
 * subscribed clients over WebTransport or WebSocket. The server performs
 * no H.264 parsing — it acts as a transparent RTP packet relay.
 *
 * Each RTP packet from FFmpeg is forwarded with a minimal 2-byte stream ID
 * prefix. Clients are responsible for RTP depacketization (RFC 6184).
 *
 * SPS/PPS codec configuration is extracted from FFmpeg's SDP output and
 * sent to clients as a JSON control message on subscription.
 *
 * Supports two transport layers:
 * - **WebTransport** (primary): Per-stream QUIC unidirectional streams
 * - **WebSocket** (fallback): Single TCP connection with binary frames
 */

import type { WebSocket as WSSocket } from 'ws';
import { RTPSource, type RTPPacketEvent, type SDPInfo } from './rtp-source.js';
import { LocalRTPSource } from './local-rtp-source.js';
import { RTSPRTPSource } from './rtsp-rtp-source.js';
import { frameLengthPrefixed, readLengthPrefixed, writeLengthPrefixed } from './framing.js';

/** Public information about a managed stream */
export interface StreamInfo {
  /** Unique stream identifier */
  id: number;
  /** Source URL or file path */
  source: string;
  /** Source type */
  sourceType: 'rtsp' | 'file';
  /** Video width in pixels (0 if SDP not yet received) */
  width: number;
  /** Video height in pixels (0 if SDP not yet received) */
  height: number;
  /** AVC codec string (empty if SDP not yet received) */
  codecString: string;
  /** Whether the stream is currently receiving data */
  active: boolean;
  /**
   * RTSP source URL.
   * @deprecated Use `source` and `sourceType` instead
   */
  rtspUrl: string;
}

/** A transport-agnostic subscriber for a specific video stream */
interface VideoSubscription {
  /** Client identifier */
  clientId: number;
  /** Send a binary frame to this subscriber (fire-and-forget) */
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
   * Single shared writer for all video data (one unidirectional QUIC stream).
   *
   * We use a single uni stream instead of one-per-subscription because
   * Chrome's QUIC initial_max_streams_uni transport parameter is ~16,
   * and 3 are consumed by HTTP/3 internals (control, QPACK encoder/decoder),
   * leaving only ~13 for application use.
   */
  videoWriter: WritableStreamDefaultWriter<Uint8Array> | null;
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
  source: string;
  sourceType: 'rtsp' | 'file';
  client: RTPSource;
  sdpInfo: SDPInfo | null;
  /** Map of clientId → video subscription for this stream */
  subscribers: Map<number, VideoSubscription>;
}

/** Client subscribe/unsubscribe message format */
interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  streamId: number;
}

let nextClientId = 1;

/**
 * Manages multiple video stream sources and distributes raw RTP packets
 * to subscribed WebTransport and WebSocket clients.
 *
 * The server is a transparent RTP relay — it does not parse H.264 data.
 * Codec configuration (SPS/PPS) is extracted from FFmpeg's SDP output
 * and sent as JSON control messages.
 */
export class StreamManager {
  private readonly streams: Map<number, ManagedStream> = new Map();
  private readonly clients: Map<number, BridgeClient> = new Map();

  /**
   * Add and connect a new stream from an RTSP URL or local file path.
   *
   * @param id - Unique stream identifier
   * @param source - RTSP URL or local file path
   * @returns Stream information (dimensions may be 0 until SDP is received)
   */
  async addStream(id: number, source: string): Promise<StreamInfo> {
    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} already exists`);
    }

    const isRtsp = source.startsWith('rtsp://');
    const client: RTPSource = isRtsp
      ? new RTSPRTPSource(source)
      : new LocalRTPSource(source);

    const managed: ManagedStream = {
      id,
      source,
      sourceType: isRtsp ? 'rtsp' : 'file',
      client,
      sdpInfo: null,
      subscribers: new Map(),
    };

    this.streams.set(id, managed);

    client.on('sdp', (info: SDPInfo) => {
      managed.sdpInfo = info;
      console.log(
        `[Stream ${id}] SDP: ${info.width}x${info.height} ${info.codecString}`
      );
    });

    client.on('rtp', (event: RTPPacketEvent) => {
      this.handleRTPPacket(managed, event);
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
   */
  removeStream(id: number): void {
    const managed = this.streams.get(id);
    if (!managed) return;

    managed.client.close();

    for (const [clientId] of managed.subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        client.subscribedStreams.delete(id);
        if (
          client.type === 'webtransport' &&
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
   */
  async handleSession(session: any): Promise<void> {
    const clientId = nextClientId++;

    const client: WTClient = {
      type: 'webtransport',
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

    session.closed
      .then((info: any) => {
        console.log(`[WT] Client ${clientId} session closed:`, info);
        this.handleClientDisconnect(clientId);
      })
      .catch((err: any) => {
        console.error(`[WT] Client ${clientId} session close error:`, err);
        this.handleClientDisconnect(clientId);
      });

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

      await this.sendControlMessage(client, {
        type: 'streams',
        streams: this.getStreams(),
      });

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
   */
  getStreams(): StreamInfo[] {
    const result: StreamInfo[] = [];
    for (const managed of this.streams.values()) {
      result.push(this.getStreamInfo(managed));
    }
    return result;
  }

  /**
   * Get the number of currently connected clients.
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
   * Send a JSON control message to a client (transport-agnostic).
   */
  private async sendControlMessage(client: BridgeClient, message: unknown): Promise<void> {
    if (!client.connected) return;

    try {
      if (client.type === 'webtransport') {
        if (!client.controlWriter) return;
        const bytes = new TextEncoder().encode(JSON.stringify(message));
        await writeLengthPrefixed(client.controlWriter, bytes);
      } else {
        if (client.ws.readyState === 1 /* OPEN */) {
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
   * Sends the SDP configuration as a control message, then begins
   * forwarding raw RTP packets.
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
        if (!client.videoWriter) {
          const sendStream = await client.session.createUnidirectionalStream();
          client.videoWriter = sendStream.getWriter();
          console.log(`[WT] Client ${client.id} video stream opened`);
        }

        const writer = client.videoWriter!;
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
        const ws = client.ws;
        subscription = {
          clientId: client.id,
          send: (frame: Buffer) => {
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(frame);
            }
          },
          isBackpressured: () => ws.bufferedAmount > 1024 * 1024,
        };
      }

      client.subscribedStreams.add(streamId);
      managed.subscribers.set(client.id, subscription);

      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.log(
        `[${tag}] Client ${client.id} subscribed to stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );

      await this.sendControlMessage(client, {
        type: 'subscribed',
        stream: this.getStreamInfo(managed),
      });

      // Send SDP config as a control message so client can set up the decoder
      this.sendSDPToSubscriber(client, managed);
    } catch (err) {
      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.error(
        `[${tag}] Failed to subscribe client ${client.id} to stream ${streamId}:`,
        err
      );
    }
  }

  /**
   * Send SDP configuration to a subscriber as a control message.
   */
  private sendSDPToSubscriber(client: BridgeClient, managed: ManagedStream): void {
    if (!managed.sdpInfo) return;

    const sdp = managed.sdpInfo;
    this.sendControlMessage(client, {
      type: 'codec-config',
      streamId: managed.id,
      spsB64: sdp.spsB64,
      ppsB64: sdp.ppsB64,
      codecString: sdp.codecString,
      width: sdp.width,
      height: sdp.height,
      payloadType: sdp.payloadType,
      clockRate: sdp.clockRate,
    }).catch(() => {});
  }

  /**
   * Unsubscribe a client from a stream.
   */
  private unsubscribeClient(client: BridgeClient, streamId: number): void {
    const managed = this.streams.get(streamId);
    if (managed) {
      managed.subscribers.delete(client.id);
      const tag = client.type === 'webtransport' ? 'WT' : 'WS';
      console.log(
        `[${tag}] Client ${client.id} unsubscribed from stream ${streamId} ` +
          `(${managed.subscribers.size} subscribers)`
      );
    }

    client.subscribedStreams.delete(streamId);

    if (
      client.type === 'webtransport' &&
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

    if (client.type === 'webtransport') {
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
    }

    this.clients.delete(clientId);
    const tag = client.type === 'webtransport' ? 'WT' : 'WS';
    console.log(`[${tag}] Client ${clientId} disconnected`);
  }

  /**
   * Handle an incoming RTP packet from a source.
   *
   * Prepends a 2-byte big-endian stream ID to the raw RTP packet and
   * forwards to all subscribers. No H.264 parsing is performed.
   *
   * Wire format per forwarded packet:
   *
   * +--2 bytes--+--variable--+
   * | Stream ID  | RTP Packet |
   * | uint16 BE  | Raw bytes  |
   * +--2 bytes--+--variable--+
   *
   * For WebTransport: wrapped in length-prefix framing.
   * For WebSocket: sent as-is (WS has message boundaries).
   */
  private handleRTPPacket(managed: ManagedStream, event: RTPPacketEvent): void {
    if (managed.subscribers.size === 0) return;

    // Prepend 2-byte stream ID to raw RTP packet
    const header = Buffer.alloc(2);
    header.writeUInt16BE(managed.id, 0);
    const frame = Buffer.concat([header, event.packet]);

    // Determine if this RTP packet contains a keyframe for backpressure decisions
    const isKeyframe = this.isRTPKeyframe(event.packet);

    this.sendToSubscribers(managed, frame, isKeyframe);
  }

  /**
   * Quick check if an RTP packet contains a keyframe (IDR) NAL unit.
   *
   * Parses the minimal RTP header to find the H.264 payload, then checks
   * the NAL unit type. Handles Single NAL, STAP-A, and FU-A packet types.
   */
  private isRTPKeyframe(packet: Buffer): boolean {
    if (packet.length < 13) return false;

    // RTP header: V(2) P(1) X(1) CC(4) M(1) PT(7) seq(16) ts(32) ssrc(32)
    const cc = packet[0] & 0x0f;
    const hasExtension = (packet[0] & 0x10) !== 0;
    let offset = 12 + cc * 4;

    // Skip header extension if present
    if (hasExtension && offset + 4 <= packet.length) {
      const extLength = packet.readUInt16BE(offset + 2);
      offset += 4 + extLength * 4;
    }

    if (offset >= packet.length) return false;

    const nalByte = packet[offset];
    const nalType = nalByte & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      // Single NAL unit packet — type 5 = IDR
      return nalType === 5;
    } else if (nalType === 24) {
      // STAP-A — check first aggregated NAL
      if (offset + 3 < packet.length) {
        const innerType = packet[offset + 3] & 0x1f;
        return innerType === 5;
      }
    } else if (nalType === 28) {
      // FU-A — check FU header
      if (offset + 1 < packet.length) {
        const fuHeader = packet[offset + 1];
        const startBit = (fuHeader & 0x80) !== 0;
        const fuType = fuHeader & 0x1f;
        return startBit && fuType === 5;
      }
    }

    return false;
  }

  /**
   * Send a frame to all subscribers of a stream.
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

      if (!isKeyframe && sub.isBackpressured()) {
        continue;
      }

      sub.send(frame);
    }
  }

  /**
   * Build a StreamInfo object from internal managed stream state.
   */
  private getStreamInfo(managed: ManagedStream): StreamInfo {
    return {
      id: managed.id,
      source: managed.source,
      sourceType: managed.sourceType,
      rtspUrl: managed.source,
      width: managed.sdpInfo?.width ?? 0,
      height: managed.sdpInfo?.height ?? 0,
      codecString: managed.sdpInfo?.codecString ?? '',
      active: managed.client.isRunning(),
    };
  }
}
