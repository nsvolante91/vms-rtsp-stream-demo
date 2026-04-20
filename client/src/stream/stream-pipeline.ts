/**
 * Stream pipeline orchestrating the full decode chain for a single stream.
 *
 * Connects the WebTransport receiver, RTP depacketizer, H.264 demuxer,
 * and WebCodecs decoder into a unified pipeline:
 *
 *   WTReceiver → RTPDepacketizer → H264Demuxer → VideoDecoder → onFrame
 *
 * The pipeline receives raw RTP packets from the server, depacketizes them
 * into H.264 access units (RFC 6184), converts to AVCC format, and feeds
 * them to the hardware-accelerated WebCodecs VideoDecoder.
 *
 * Codec configuration (SPS/PPS) is received via the control channel from
 * the server's SDP output, with fallback to in-band parameter sets.
 */

import { Logger } from '../utils/logger';
import { H264Demuxer } from './h264-demuxer';
import { VideoStreamDecoder } from './decoder';
import { RTPDepacketizer, type AccessUnit } from './rtp-depacketizer';
import type { WTReceiver } from './wt-receiver';
import type { CodecConfig, ReceivedRTPPacket } from './wt-receiver';

/** Transport-agnostic receiver interface for stream subscription */
export interface StreamReceiver {
  subscribe(
    streamId: number,
    rtpCallback: (packet: ReceivedRTPPacket) => void,
    configCallback?: (config: CodecConfig) => void
  ): void;
  unsubscribe(streamId: number): void;
}

/**
 * Full decode pipeline for a single video stream.
 *
 * Subscribes to the shared WTReceiver for its stream, depacketizes
 * incoming RTP packets into H.264 access units, decodes via WebCodecs,
 * and forwards each decoded VideoFrame to the onFrame callback.
 *
 * CRITICAL: The onFrame callback MUST call frame.close() after rendering,
 * or GPU memory will leak catastrophically.
 */
export class StreamPipeline {
  private readonly demuxer: H264Demuxer;
  private readonly depacketizer: RTPDepacketizer;
  private decoder: VideoStreamDecoder | null = null;
  private _started = false;
  private _decodedFrameCount = 0;
  private readonly log: Logger;

  /**
   * Create a new StreamPipeline.
   * @param streamId - Numeric stream identifier
   * @param receiver - Shared stream receiver instance (WebTransport or WebSocket)
   * @param onFrame - Callback invoked with each decoded frame. MUST call frame.close().
   * @param onError - Optional error callback for this stream
   */
  constructor(
    private readonly streamId: number,
    private readonly receiver: StreamReceiver,
    private readonly onFrame: (frame: VideoFrame) => void,
    private readonly onError?: (streamId: number, error: Error) => void
  ) {
    this.demuxer = new H264Demuxer();
    this.depacketizer = new RTPDepacketizer();
    this.log = new Logger(`Pipeline[${streamId}]`);
  }

  /**
   * Start the decode pipeline.
   *
   * Creates the decoder, subscribes to the receiver for this stream's
   * RTP packets and codec config, and begins processing.
   */
  start(): void {
    if (this._started) {
      this.log.warn('Pipeline already started');
      return;
    }

    this._started = true;

    this.decoder = new VideoStreamDecoder(
      this.streamId,
      (frame: VideoFrame) => this.handleDecodedFrame(frame),
      (error: Error) => {
        this.log.error('Decoder error', error);
        if (this.onError) {
          this.onError(this.streamId, error);
        }
      }
    );

    // Wire up the RTP depacketizer to deliver access units
    this.depacketizer.onAccessUnit = (au: AccessUnit) => {
      this.handleAccessUnit(au);
    };

    // Subscribe to the receiver for RTP packets and codec config
    this.receiver.subscribe(
      this.streamId,
      (packet: ReceivedRTPPacket) => {
        this.depacketizer.processPacket(packet.packet);
      },
      (config: CodecConfig) => {
        this.handleCodecConfig(config);
      }
    );

    this.log.info('Pipeline started');
  }

  /**
   * Stop the decode pipeline.
   */
  stop(): void {
    if (!this._started) return;

    this._started = false;
    this.receiver.unsubscribe(this.streamId);
    this.depacketizer.reset();

    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }

    this.log.info('Pipeline stopped');
  }

  /** Whether this pipeline is currently active */
  get active(): boolean {
    return this._started;
  }

  /** Current performance metrics for this stream's decoder */
  get metrics(): { decodedFrames: number; droppedFrames: number; queueSize: number } {
    if (!this.decoder) {
      return { decodedFrames: 0, droppedFrames: 0, queueSize: 0 };
    }
    return {
      decodedFrames: this.decoder.decodedFrames,
      droppedFrames: this.decoder.droppedFrames,
      queueSize: this.decoder.queueSize,
    };
  }

  /** Video resolution from the config, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    return this.demuxer.resolution;
  }

  /**
   * Handle codec configuration received from the server via control channel.
   */
  private handleCodecConfig(config: CodecConfig): void {
    this.log.info(`Received codec config: ${config.codecString} ${config.width}x${config.height}`);
    const decoderConfig = this.demuxer.processCodecConfig(config);
    if (decoderConfig && this.decoder) {
      this.decoder.configure(decoderConfig);
    }
  }

  /**
   * Handle a complete access unit from the RTP depacketizer.
   *
   * Checks for in-band SPS/PPS (common in STAP-A packets before IDR),
   * then creates an EncodedVideoChunk and feeds it to the decoder.
   */
  private handleAccessUnit(au: AccessUnit): void {
    // Check for in-band SPS/PPS NAL units
    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;

    for (const nal of au.nalUnits) {
      if (nal.type === 7) sps = nal.data; // SPS
      if (nal.type === 8) pps = nal.data; // PPS
    }

    // If we found in-band SPS+PPS, try to configure/reconfigure
    if (sps && pps && this.decoder) {
      const config = this.demuxer.processInBandConfig(sps, pps);
      if (config) {
        this.log.info('Reconfiguring decoder from in-band SPS/PPS');
        this.decoder.configure(config);
      }
    }

    if (!this.demuxer.isConfigured || !this.decoder) {
      return;
    }

    const chunk = this.demuxer.createChunkFromAU(au);
    if (chunk) {
      this.decoder.decode(chunk);
    }
  }

  /**
   * Handle a decoded VideoFrame from the decoder.
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    this._decodedFrameCount++;
    if (this._decodedFrameCount <= 3 || this._decodedFrameCount % 300 === 0) {
      this.log.info(`Decoded frame ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrameCount})`);
    }
    this.onFrame(frame);
  }
}
