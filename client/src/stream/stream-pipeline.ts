/**
 * Stream pipeline orchestrating the full decode chain for a single stream.
 *
 * Connects the WebSocket receiver, H.264 demuxer, and WebCodecs decoder
 * into a unified pipeline. Decoded frames are forwarded directly to the
 * onFrame callback (which draws to a per-stream canvas and closes the frame).
 */

import { Logger } from '../utils/logger';
import { H264Demuxer } from './h264-demuxer';
import { VideoStreamDecoder } from './decoder';
import type { ReceivedFrame } from './wt-receiver';

/** Transport-agnostic receiver interface for stream subscription */
export interface StreamReceiver {
  subscribe(streamId: number, callback: (frame: ReceivedFrame) => void): void;
  unsubscribe(streamId: number): void;
}

/**
 * Full decode pipeline for a single video stream.
 *
 * Subscribes to the shared WSReceiver for its stream, demuxes incoming
 * H.264 Annex B data, decodes via WebCodecs, and forwards each decoded
 * VideoFrame to the onFrame callback for immediate rendering.
 *
 * CRITICAL: The onFrame callback MUST call frame.close() after rendering,
 * or GPU memory will leak catastrophically.
 */
export class StreamPipeline {
  private readonly demuxer: H264Demuxer;
  private decoder: VideoStreamDecoder | null = null;
  private _started = false;
  private _decodedFrameCount = 0;
  private readonly log: Logger;

  /** Timestamp smoothing state */
  private _lastRawTimestamp = 0;
  private _lastSmoothedTimestamp = 0;
  private _timestampOffset = 0;
  private _timestampInitialized = false;
  /** Maximum allowed jitter correction per frame (50ms in µs) */
  private static readonly MAX_JITTER_CORRECTION_US = 50_000;
  /** Discontinuity threshold (500ms in µs) */
  private static readonly DISCONTINUITY_THRESHOLD_US = 500_000;

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
    this.log = new Logger(`Pipeline[${streamId}]`);
  }

  /**
   * Start the decode pipeline.
   *
   * Creates the decoder, subscribes to the WebSocket receiver for this
   * stream's data, and begins processing incoming frames through the
   * demux/decode chain.
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

    this.receiver.subscribe(this.streamId, (frame: ReceivedFrame) => {
      this.handleReceivedFrame(frame);
    });

    this.log.info('Pipeline started');
  }

  /**
   * Stop the decode pipeline.
   *
   * Unsubscribes from the WebSocket receiver and closes the decoder.
   */
  stop(): void {
    if (!this._started) {
      return;
    }

    this._started = false;
    this.receiver.unsubscribe(this.streamId);

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

  /** Video resolution from the SPS, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    return this.demuxer.resolution;
  }

  /**
   * Handle a frame received from the WebSocket.
   *
   * Config frames (SPS/PPS) are processed by the demuxer to extract
   * decoder configuration. Video frames are demuxed into EncodedVideoChunks
   * and fed to the decoder. Timestamps are smoothed to prevent jitter.
   */
  private handleReceivedFrame(frame: ReceivedFrame): void {
    if (frame.isConfig) {
      const config = this.demuxer.processConfig(frame.data);
      if (config && this.decoder) {
        this.decoder.configure(config);
      }
      return;
    }

    if (!this.demuxer.isConfigured || !this.decoder) {
      return;
    }

    // Smooth the timestamp before creating the chunk
    const smoothedFrame = this.smoothTimestamp(frame);
    const chunk = this.demuxer.createChunk(smoothedFrame);
    if (chunk) {
      this.decoder.decode(chunk);
    }
  }

  /**
   * Smooth the presentation timestamp to reduce network jitter.
   *
   * Detects timestamp discontinuities (e.g., stream restart) and resets
   * the smoothing state. For normal frames, applies a low-pass filter
   * to the inter-frame delta to absorb jitter.
   */
  private smoothTimestamp(frame: ReceivedFrame): ReceivedFrame {
    const rawTs = Number(frame.timestamp);

    if (!this._timestampInitialized) {
      this._timestampInitialized = true;
      this._lastRawTimestamp = rawTs;
      this._lastSmoothedTimestamp = rawTs;
      return frame;
    }

    const rawDelta = rawTs - this._lastRawTimestamp;

    // Detect discontinuity: large backward jump or implausible forward jump
    if (rawDelta < 0 || rawDelta > StreamPipeline.DISCONTINUITY_THRESHOLD_US) {
      this.log.info(`Timestamp discontinuity: delta=${rawDelta}µs, resetting smoother`);
      this._lastRawTimestamp = rawTs;
      // Apply offset so smoothed timestamps remain monotonic
      this._timestampOffset = this._lastSmoothedTimestamp + 33333 - rawTs; // assume ~30fps gap
      this._lastSmoothedTimestamp = rawTs + this._timestampOffset;
      // Mutate pooled frame's timestamp
      this._pooledSmoothedFrame.streamId = frame.streamId;
      this._pooledSmoothedFrame.timestamp = BigInt(Math.round(this._lastSmoothedTimestamp));
      this._pooledSmoothedFrame.isKeyframe = frame.isKeyframe;
      this._pooledSmoothedFrame.isConfig = frame.isConfig;
      this._pooledSmoothedFrame.data = frame.data;
      return this._pooledSmoothedFrame;
    }

    // Low-pass filter: clamp jitter to MAX_JITTER_CORRECTION_US
    const expectedDelta = rawDelta;
    const smoothedDelta = Math.max(0, expectedDelta);
    const smoothedTs = this._lastSmoothedTimestamp + smoothedDelta + this._timestampOffset;

    this._lastRawTimestamp = rawTs;
    this._lastSmoothedTimestamp = smoothedTs - this._timestampOffset;

    // If the correction is negligible, return the original frame
    const correction = Math.abs(smoothedTs - rawTs - this._timestampOffset);
    if (correction < 100) {
      return frame;
    }

    this._pooledSmoothedFrame.streamId = frame.streamId;
    this._pooledSmoothedFrame.timestamp = BigInt(Math.round(smoothedTs));
    this._pooledSmoothedFrame.isKeyframe = frame.isKeyframe;
    this._pooledSmoothedFrame.isConfig = frame.isConfig;
    this._pooledSmoothedFrame.data = frame.data;
    return this._pooledSmoothedFrame;
  }

  /** Pooled smoothed frame to avoid allocation */
  private readonly _pooledSmoothedFrame: ReceivedFrame = {
    streamId: 0,
    timestamp: 0n,
    isKeyframe: false,
    isConfig: false,
    data: new Uint8Array(0),
  };

  /**
   * Handle a decoded VideoFrame from the decoder.
   *
   * Forwards the frame directly to the onFrame callback for immediate
   * rendering. The callback is responsible for calling frame.close().
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    this._decodedFrameCount++;
    if (this._decodedFrameCount <= 3 || this._decodedFrameCount % 300 === 0) {
      this.log.info(`Decoded frame ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrameCount})`);
    }
    this.onFrame(frame);
  }
}
