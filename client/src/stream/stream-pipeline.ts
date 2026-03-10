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
import { getResolutionProfile } from './resolution-profile';
import type { ResolutionTier } from './resolution-profile';
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
  /** Running average of inter-frame delta (µs) for jitter baseline */
  private _expectedFrameDelta = 0;
  /** Maximum allowed jitter correction per frame (microseconds).
   *  Clamps the deviation from the running-average frame period,
   *  NOT the total delta.  Adapts to resolution: SD=10ms, HD=20ms, UHD=25ms. */
  private _maxJitterCorrectionUs = 20_000;
  /** Discontinuity threshold in µs — adapted per-stream based on fps.
   *  Defaults to 5 seconds; updated to ~20 frames worth when fps is known. */
  private _discontinuityThresholdUs = 5_000_000;

  // ── Frame timing & stutter detection ───────────────────────
  /** Rolling buffer of inter-frame intervals (ms) */
  private _frameIntervals: number[] = [];
  /** Timestamp of last decoded frame (performance.now()) */
  private _lastFrameTime = 0;
  /** Cumulative stutter count (frame interval > 2× median) */
  private _stutterCount = 0;
  /** Frame interval window size — time-normalized to ~2 seconds of frames */
  private _frameIntervalWindow = 60;

  // ── Bitrate tracking ───────────────────────────────────────
  /** Accumulated bytes received since last metrics read */
  private _bytesReceived = 0;
  /** Timestamp of last bitrate reset */
  private _bytesTimestamp = 0;

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
  get metrics(): {
    decodedFrames: number;
    droppedFrames: number;
    queueSize: number;
    decodeTimeMs: number;
    frameIntervalMs: number;
    frameIntervalJitterMs: number;
    stutterCount: number;
  } {
    if (!this.decoder) {
      return {
        decodedFrames: 0, droppedFrames: 0, queueSize: 0,
        decodeTimeMs: 0, frameIntervalMs: 0, frameIntervalJitterMs: 0, stutterCount: 0,
      };
    }

    // Compute frame interval stats
    let frameIntervalMs = 0;
    let frameIntervalJitterMs = 0;
    const intervals = this._frameIntervals;
    if (intervals.length > 0) {
      const sum = intervals.reduce((a, b) => a + b, 0);
      frameIntervalMs = sum / intervals.length;
      if (intervals.length > 1) {
        const mean = frameIntervalMs;
        const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
        frameIntervalJitterMs = Math.sqrt(variance);
      }
    }

    return {
      decodedFrames: this.decoder.decodedFrames,
      droppedFrames: this.decoder.droppedFrames,
      queueSize: this.decoder.queueSize,
      decodeTimeMs: this.decoder.avgDecodeTimeMs,
      frameIntervalMs,
      frameIntervalJitterMs,
      stutterCount: this._stutterCount,
    };
  }

  /**
   * Get accumulated bytes since last call and reset counter.
   * Used by the worker metrics reporter for bitrate calculation.
   */
  consumeBytes(): { bytes: number; elapsedMs: number } {
    const now = performance.now();
    const elapsed = this._bytesTimestamp > 0 ? now - this._bytesTimestamp : 1000;
    const bytes = this._bytesReceived;
    this._bytesReceived = 0;
    this._bytesTimestamp = now;
    return { bytes, elapsedMs: elapsed };
  }

  /** Video resolution from the SPS, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    return this.demuxer.resolution;
  }

  /** Source fps from SPS VUI timing info, or null if unknown */
  get fps(): number | null {
    return this.demuxer.fps;
  }

  /** Current resolution tier driving adaptive thresholds */
  get resolutionTier(): ResolutionTier {
    return this.decoder?.resolutionTier ?? 'hd';
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
        const fps = this.demuxer.fps ?? 0;
        this.decoder.configure(config, fps);
        // Adapt thresholds to the detected resolution and fps
        if (config.codedWidth && config.codedHeight) {
          const fps = this.demuxer.fps ?? 0;
          const profile = getResolutionProfile(config.codedWidth, config.codedHeight, fps);
          this._maxJitterCorrectionUs = profile.maxJitterCorrectionUs;
          // Scale discontinuity threshold: ~20 frames at source fps
          // (min 500ms to tolerate network bursts, max 5s to catch real errors)
          const effectiveFps = profile.fps;
          const twentyFramesUs = Math.round((20 / effectiveFps) * 1_000_000);
          this._discontinuityThresholdUs = Math.max(500_000, Math.min(5_000_000, twentyFramesUs));
          // Scale frame interval window to ~2 seconds of frames
          this._frameIntervalWindow = Math.max(10, Math.round(effectiveFps * 2));
          this.log.info(
            `Adapted to ${profile.tier}@${effectiveFps}fps: jitter=${profile.maxJitterCorrectionUs}µs, ` +
            `discontinuity=${this._discontinuityThresholdUs}µs, intervalWindow=${this._frameIntervalWindow}`
          );
        }
      }
      return;
    }

    if (!this.demuxer.isConfigured || !this.decoder) {
      return;
    }

    // Track bytes received for bitrate calculation
    this._bytesReceived += frame.data.byteLength;

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
    if (rawDelta < 0 || rawDelta > this._discontinuityThresholdUs) {
      this.log.info(`Timestamp discontinuity: delta=${rawDelta}µs, resetting smoother`);
      this._lastRawTimestamp = rawTs;
      // Apply offset so smoothed timestamps remain monotonic
      const gapUs = this._expectedFrameDelta > 0 ? this._expectedFrameDelta : 33333;
      this._timestampOffset = this._lastSmoothedTimestamp + gapUs - rawTs;
      this._lastSmoothedTimestamp = rawTs + this._timestampOffset;
      this._expectedFrameDelta = 0; // reset EMA on discontinuity
      // Mutate pooled frame's timestamp
      this._pooledSmoothedFrame.streamId = frame.streamId;
      this._pooledSmoothedFrame.timestamp = BigInt(Math.round(this._lastSmoothedTimestamp));
      this._pooledSmoothedFrame.isKeyframe = frame.isKeyframe;
      this._pooledSmoothedFrame.isConfig = frame.isConfig;
      this._pooledSmoothedFrame.data = frame.data;
      return this._pooledSmoothedFrame;
    }

    // Update running average of frame period (EMA, α=0.05)
    if (this._expectedFrameDelta === 0) {
      this._expectedFrameDelta = rawDelta;
    } else {
      this._expectedFrameDelta += (rawDelta - this._expectedFrameDelta) * 0.05;
    }

    // Clamp the **deviation** from the expected frame period, not the total delta.
    // This absorbs network jitter without systematically shrinking the delta.
    const deviation = rawDelta - this._expectedFrameDelta;
    const clampedDeviation = Math.max(-this._maxJitterCorrectionUs, Math.min(deviation, this._maxJitterCorrectionUs));
    const smoothedDelta = Math.max(0, this._expectedFrameDelta + clampedDeviation);
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

    // Track inter-frame timing for stutter detection
    const now = performance.now();
    if (this._lastFrameTime > 0) {
      const interval = now - this._lastFrameTime;
      this._frameIntervals.push(interval);
      if (this._frameIntervals.length > this._frameIntervalWindow) {
        this._frameIntervals.shift();
      }
      // Stutter detection: interval > 2× running average
      if (this._frameIntervals.length >= 5) {
        let sum = 0;
        for (let i = 0; i < this._frameIntervals.length; i++) sum += this._frameIntervals[i];
        const avg = sum / this._frameIntervals.length;
        if (interval > avg * 2) {
          this._stutterCount++;
        }
      }
    }
    this._lastFrameTime = now;

    if (this._decodedFrameCount <= 3 || this._decodedFrameCount % 300 === 0) {
      this.log.info(`Decoded frame ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrameCount})`);
    }
    try {
      this.onFrame(frame);
    } catch (e) {
      try { frame.close(); } catch { /* already closed */ }
      this.log.error('onFrame callback threw', e);
    }
  }
}
