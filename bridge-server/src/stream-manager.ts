/**
 * Stream Manager
 *
 * Manages multiple RTSP-to-WebSocket bridges. Each managed stream maintains
 * an RTSPClient connection and forwards H.264 NAL units to subscribed
 * WebSocket clients using a compact binary protocol.
 */

import { WebSocket } from 'ws';
import { RTSPClient, type NALUEvent } from './rtsp-client.js';
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
  /** Set of WebSocket clients subscribed to this stream */
  subscribers: Set<WebSocket>;
  /** Pending access unit accumulator for VCL NAL units */
  pendingAU: PendingAccessUnit | null;
}

/** Client subscribe/unsubscribe message format */
interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  streamId: number;
}

/**
 * Build a binary frame for the WebSocket protocol.
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

  // Version: 1 byte
  header.writeUInt8(PROTOCOL_VERSION, 0);

  // Stream ID: 2 bytes, big-endian
  header.writeUInt16BE(streamId, 1);

  // Timestamp: 8 bytes, big-endian unsigned 64-bit
  header.writeBigUInt64BE(timestamp, 3);

  // Flags: 1 byte
  header.writeUInt8(flags, 11);

  // Combine header + payload
  return Buffer.concat([header, payload]);
}

/**
 * Manages multiple RTSP stream connections and distributes H.264 data
 * to subscribed WebSocket clients.
 *
 * Each stream is backed by an RTSPClient that connects to an RTSP source
 * via FFmpeg. When clients subscribe to a stream, they first receive the
 * cached SPS/PPS configuration NAL units (needed to initialize a decoder),
 * then receive ongoing NAL units as binary WebSocket frames.
 *
 * @example
 * ```typescript
 * const manager = new StreamManager();
 * await manager.addStream(1, 'rtsp://localhost:8554/stream1');
 * // When a WebSocket connects:
 * manager.handleClient(ws);
 * // Client sends: { "type": "subscribe", "streamId": 1 }
 * ```
 */
export class StreamManager {
  private readonly streams: Map<number, ManagedStream> = new Map();
  private readonly clients: Map<WebSocket, Set<number>> = new Map();

  /**
   * Add and connect a new RTSP stream.
   *
   * Creates an RTSPClient, connects to the RTSP URL, and begins receiving
   * H.264 NAL units. SPS and PPS NAL units are cached for sending to
   * new subscribers.
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
      subscribers: new Set(),
      pendingAU: null,
    };

    this.streams.set(id, managed);

    // Handle SPS updates
    client.on('sps', (info: SPSInfo) => {
      managed.spsInfo = info;
      console.log(
        `[Stream ${id}] SPS: ${info.width}x${info.height} ${info.codecString}`
      );
    });

    // Handle NAL units — accumulate into access units before broadcasting
    client.on('nalu', (event: NALUEvent) => {
      // Cache SPS and PPS
      if (event.type === 7) {
        managed.spsNALU = new Uint8Array(event.nalUnit);
      } else if (event.type === 8) {
        managed.ppsNALU = new Uint8Array(event.nalUnit);
      }

      this.handleNALU(managed, event);
    });

    // Handle errors
    client.on('error', (err: Error) => {
      console.error(`[Stream ${id}] Error: ${err.message}`);
    });

    // Handle stream close
    client.on('close', () => {
      console.log(`[Stream ${id}] Connection closed`);
    });

    // Connect to the stream
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
   * Closes the RTSP connection and notifies all subscribers that the
   * stream is no longer available.
   *
   * @param id - Stream identifier to remove
   */
  removeStream(id: number): void {
    const managed = this.streams.get(id);
    if (!managed) {
      return;
    }

    // Discard any pending access unit
    managed.pendingAU = null;

    // Close the RTSP client
    managed.client.close();

    // Remove stream subscriptions from all clients
    for (const [ws, subscriptions] of this.clients) {
      subscriptions.delete(id);
    }

    managed.subscribers.clear();
    this.streams.delete(id);
    console.log(`[Stream ${id}] Removed`);
  }

  /**
   * Handle a new WebSocket client connection.
   *
   * Sets up message handling for subscribe/unsubscribe commands and
   * cleanup on disconnect.
   *
   * @param ws - WebSocket connection
   */
  handleClient(ws: WebSocket): void {
    this.clients.set(ws, new Set());

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      // Client control messages are JSON text
      if (!isBinary) {
        this.handleClientMessage(ws, data.toString());
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnect(ws);
    });

    ws.on('error', (err: Error) => {
      console.error(`[Client] WebSocket error: ${err.message}`);
      this.handleClientDisconnect(ws);
    });

    // Send the list of available streams on connect
    const streamList = this.getStreams();
    try {
      ws.send(
        JSON.stringify({
          type: 'streams',
          streams: streamList,
        })
      );
    } catch {
      // Client may have disconnected immediately
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
   * Get the number of currently connected WebSocket clients.
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
    for (const [ws] of this.clients) {
      try {
        ws.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
  }

  /**
   * Process a JSON control message from a client.
   *
   * @param ws - Source WebSocket connection
   * @param message - Raw JSON string
   */
  private handleClientMessage(ws: WebSocket, message: string): void {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      console.warn('[Client] Invalid JSON message received');
      return;
    }

    if (parsed.type === 'subscribe') {
      this.subscribeClient(ws, parsed.streamId);
    } else if (parsed.type === 'unsubscribe') {
      this.unsubscribeClient(ws, parsed.streamId);
    }
  }

  /**
   * Subscribe a client to a stream.
   *
   * Adds the client to the stream's subscriber set and sends cached
   * SPS/PPS configuration NAL units so the client can initialize its decoder.
   *
   * @param ws - WebSocket client
   * @param streamId - Stream to subscribe to
   */
  private subscribeClient(ws: WebSocket, streamId: number): void {
    const managed = this.streams.get(streamId);
    if (!managed) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Stream ${streamId} not found`,
          })
        );
      } catch {
        // Client may have disconnected
      }
      return;
    }

    const subscriptions = this.clients.get(ws);
    if (!subscriptions) {
      return;
    }

    subscriptions.add(streamId);
    managed.subscribers.add(ws);

    console.log(
      `[Client] Subscribed to stream ${streamId} (${managed.subscribers.size} subscribers)`
    );

    // Send stream info
    try {
      ws.send(
        JSON.stringify({
          type: 'subscribed',
          stream: this.getStreamInfo(managed),
        })
      );
    } catch {
      return;
    }

    // Send cached SPS/PPS config so the client can initialize its decoder
    this.sendConfig(ws, managed);
  }

  /**
   * Send cached SPS and PPS NAL units to a client.
   *
   * @param ws - Target WebSocket client
   * @param managed - Stream with cached config data
   */
  private sendConfig(ws: WebSocket, managed: ManagedStream): void {
    if (!managed.spsNALU || !managed.ppsNALU) {
      return;
    }

    // Build a config frame containing both SPS and PPS with Annex B start codes
    const startCode = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    const payload = Buffer.concat([
      startCode,
      managed.spsNALU,
      startCode,
      managed.ppsNALU,
    ]);

    const flags = FLAG_CONFIG;
    const frame = buildFrame(managed.id, 0n, flags, payload);

    try {
      ws.send(frame);
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Unsubscribe a client from a stream.
   *
   * @param ws - WebSocket client
   * @param streamId - Stream to unsubscribe from
   */
  private unsubscribeClient(ws: WebSocket, streamId: number): void {
    const managed = this.streams.get(streamId);
    if (managed) {
      managed.subscribers.delete(ws);
      console.log(
        `[Client] Unsubscribed from stream ${streamId} (${managed.subscribers.size} subscribers)`
      );
    }

    const subscriptions = this.clients.get(ws);
    if (subscriptions) {
      subscriptions.delete(streamId);
    }
  }

  /**
   * Handle client disconnection cleanup.
   *
   * Removes the client from all stream subscriber sets and the client map.
   *
   * @param ws - Disconnected WebSocket client
   */
  private handleClientDisconnect(ws: WebSocket): void {
    const subscriptions = this.clients.get(ws);
    if (subscriptions) {
      for (const streamId of subscriptions) {
        const managed = this.streams.get(streamId);
        if (managed) {
          managed.subscribers.delete(ws);
        }
      }
    }
    this.clients.delete(ws);
  }

  /**
   * Route a NAL unit to the appropriate handler.
   *
   * Config NALs (SPS/PPS) are broadcast immediately as config frames
   * for decoder initialization. VCL NALs are accumulated into complete
   * access units before being sent to subscribers.
   *
   * @param managed - Source stream
   * @param event - NAL unit event to handle
   */
  private handleNALU(managed: ManagedStream, event: NALUEvent): void {
    // Config NALs: broadcast immediately for decoder initialization
    if (isConfigNAL(event.type)) {
      if (managed.subscribers.size === 0) return;

      const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
      const payload = Buffer.concat([startCode, event.nalUnit]);
      const frame = buildFrame(managed.id, event.timestamp, FLAG_CONFIG, payload);
      this.sendToSubscribers(managed, frame);
      return;
    }

    // Skip non-VCL NALs (AUD, SEI, etc.) — not needed by the client
    if (!isVCLNAL(event.type)) {
      return;
    }

    // VCL NAL — accumulate into a complete access unit.
    // An access unit contains all slices for one picture. We detect the
    // boundary by checking first_mb_in_slice: if 0, this is the first
    // (or only) slice of a new picture.
    const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const naluBuf = Buffer.concat([startCode, event.nalUnit]);

    if (isFirstSliceInPicture(event.nalUnit)) {
      // First slice of a new picture — flush the previous access unit
      this.flushAccessUnit(managed);

      // Start a new access unit
      managed.pendingAU = {
        payload: naluBuf,
        timestamp: event.timestamp,
        isKeyframe: event.isKeyframe,
      };
    } else if (managed.pendingAU) {
      // Continuation slice — append to the current access unit
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
   * Sends the accumulated VCL NAL units as a single binary WebSocket
   * message, ensuring the client receives a complete access unit per chunk.
   *
   * @param managed - Stream with pending access unit to flush
   */
  private flushAccessUnit(managed: ManagedStream): void {
    const au = managed.pendingAU;
    managed.pendingAU = null;

    if (!au || managed.subscribers.size === 0) {
      return;
    }

    let flags = 0;
    if (au.isKeyframe) {
      flags |= FLAG_KEYFRAME;
    }

    const frame = buildFrame(managed.id, au.timestamp, flags, au.payload);
    this.sendToSubscribers(managed, frame);
  }

  /**
   * Send a binary frame to all subscribers of a stream.
   *
   * Clients with closed or errored connections are removed from the
   * subscriber set.
   *
   * @param managed - Source stream
   * @param frame - Binary frame to send
   */
  private sendToSubscribers(managed: ManagedStream, frame: Buffer): void {
    for (const ws of managed.subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(frame);
        } catch {
          managed.subscribers.delete(ws);
        }
      } else {
        managed.subscribers.delete(ws);
      }
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
