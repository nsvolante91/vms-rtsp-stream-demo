/**
 * WebCodecs VideoDecoder wrapper with backpressure management.
 *
 * Wraps the browser's VideoDecoder API and provides automatic
 * backpressure handling: non-keyframes are dropped when the decode
 * queue is congested, while keyframes are always decoded to prevent
 * stream corruption.
 */

import { Logger } from '../utils/logger';
import { getResolutionProfile, type ResolutionProfile, type ResolutionTier } from './resolution-profile';

/** Callback invoked when the decoder outputs a decoded VideoFrame */
export type FrameOutputCallback = (frame: VideoFrame) => void;

/** Default thresholds used until resolution is known (HD-tier values) */
const DEFAULT_NORMAL_THRESHOLD = 3;
const DEFAULT_SOFT_THRESHOLD = 5;
const DEFAULT_HARD_THRESHOLD = 8;

/** Minimum interval between recovery attempts in milliseconds */
const RECOVERY_COOLDOWN_MS = 1000;

/**
 * VideoDecoder wrapper that manages decoding lifecycle, backpressure,
 * and frame output for a single video stream.
 *
 * CRITICAL: The caller (or downstream consumer) MUST call VideoFrame.close()
 * on every frame received through the onFrame callback, or GPU memory
 * will leak catastrophically.
 */
export class VideoStreamDecoder {
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  private _droppedFrames = 0;
  private _decodedFrames = 0;
  private _lastDecodeTime = 0;
  private _waitingForKeyframe = true;
  private _lastRecoveryTime = 0;
  private _softwareFallback = false;
  /** Previous queue size for tracking derivative (proactive dropping) */
  private _prevQueueSize = 0;
  private readonly log: Logger;

  // ── Resolution-adaptive thresholds ─────────────────────────
  private _normalThreshold = DEFAULT_NORMAL_THRESHOLD;
  private _softThreshold = DEFAULT_SOFT_THRESHOLD;
  private _hardThreshold = DEFAULT_HARD_THRESHOLD;
  private _resolutionTier: ResolutionTier = 'hd';

  // ── Rolling average frame size for adaptive B-frame heuristic ──
  /** Rolling average of recent non-keyframe sizes (bytes) */
  private _avgFrameSize = 0;
  /** Number of samples in the rolling average */
  private _frameSizeSamples = 0;
  private static readonly FRAME_SIZE_ALPHA = 0.05;

  // ── Decode time tracking ──────────────────────────────────
  /** Timestamps of chunks submitted for decoding (rolling, capped at 30) */
  private _decodeSubmitTimes: number[] = [];
  /** Rolling decode time samples (ms) for averaging */
  private _decodeTimeSamples: number[] = [];
  private static readonly MAX_DECODE_SAMPLES = 60;

  /**
   * Create a new VideoStreamDecoder.
   * @param streamId - Stream identifier for logging purposes
   * @param onFrame - Callback invoked with each decoded VideoFrame (caller MUST close it)
   * @param onError - Callback invoked when the decoder encounters an error
   */
  constructor(
    private readonly streamId: number,
    private readonly onFrame: FrameOutputCallback,
    private readonly onError: (error: Error) => void
  ) {
    this.log = new Logger(`Decoder[${streamId}]`);
  }

  /**
   * Configure the decoder with the given video configuration.
   *
   * Creates a new VideoDecoder instance (closing any existing one),
   * configures it with the provided config, and starts accepting
   * encoded chunks.
   *
   * @param config - VideoDecoderConfig with codec string, dimensions, and acceleration hints
   * @param fps - Source framerate from SPS VUI (0 = unknown, falls back to 30)
   */
  configure(config: VideoDecoderConfig, fps = 0): void {
    this.log.info(`Configuring decoder: ${config.codec} ${config.codedWidth}x${config.codedHeight} @${fps || '?'}fps`);

    // Apply resolution- and fps-adaptive thresholds
    if (config.codedWidth && config.codedHeight) {
      const profile = getResolutionProfile(config.codedWidth, config.codedHeight, fps);
      this._normalThreshold = profile.normalThreshold;
      this._softThreshold = profile.softThreshold;
      this._hardThreshold = profile.hardThreshold;
      this._resolutionTier = profile.tier;
      this.log.info(`Resolution tier: ${profile.tier}@${profile.fps}fps (thresholds: ${profile.normalThreshold}/${profile.softThreshold}/${profile.hardThreshold})`);
    }

    // Log description details for debugging
    if (config.description) {
      const desc = config.description instanceof ArrayBuffer
        ? new Uint8Array(config.description)
        : new Uint8Array((config.description as ArrayBufferView).buffer,
            (config.description as ArrayBufferView).byteOffset,
            (config.description as ArrayBufferView).byteLength);
      this.log.info(`avcC description: ${desc.length} bytes, hex=${Array.from(desc.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}...`);
    }

    // Check isConfigSupported asynchronously (non-blocking diagnostic)
    VideoDecoder.isConfigSupported(config).then(result => {
      this.log.info(`isConfigSupported: ${result.supported}`);
    }).catch(err => {
      this.log.error('isConfigSupported error', err);
    });

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Ignore errors when closing a previously errored decoder
      }
    }

    this.config = config;
    this._waitingForKeyframe = true;
    this._softwareFallback = false;

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.handleDecoderOutput(frame),
      error: (error: DOMException) => {
        this.log.error('Decoder error', error);
        // On first error, try software decoding before reporting to pipeline
        if (!this._softwareFallback && this.config) {
          this._softwareFallback = true;
          this.log.info('Hardware decode failed, trying software fallback...');
          try {
            const swConfig = { ...this.config, hardwareAcceleration: 'prefer-software' as HardwareAcceleration };
            this.configureDirect(swConfig);
            return;
          } catch (e) {
            this.log.error('Software fallback configure failed', e);
          }
        }
        this.onError(new Error(`Decoder error: ${error.message}`));
        this.recoverFromError();
      },
    });

    this.decoder.configure(config);
  }

  /** Shared output handler for decoded VideoFrames. */
  private handleDecoderOutput(frame: VideoFrame): void {
    this._decodedFrames++;
    this._lastDecodeTime = performance.now();
    // Record decode time from oldest pending submit
    if (this._decodeSubmitTimes.length > 0) {
      const submitTime = this._decodeSubmitTimes.shift()!;
      const dt = this._lastDecodeTime - submitTime;
      this._decodeTimeSamples.push(dt);
      if (this._decodeTimeSamples.length > VideoStreamDecoder.MAX_DECODE_SAMPLES) {
        this._decodeTimeSamples.shift();
      }
    }
    if (this._decodedFrames <= 3 || this._decodedFrames % 60 === 0) {
      this.log.info(`Frame decoded [stream ${this.streamId}] ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrames})`);
    }
    try {
      this.onFrame(frame);
    } catch {
      try { frame.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Direct configure without diagnostics (used by software fallback).
   */
  private configureDirect(config: VideoDecoderConfig): void {
    this.log.info(`Configuring decoder (fallback): ${config.codec} ${config.codedWidth}x${config.codedHeight} hw=${config.hardwareAcceleration}`);

    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Ignore
      }
    }

    this.config = config;
    this._waitingForKeyframe = true;

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.handleDecoderOutput(frame),
      error: (error: DOMException) => {
        this.log.error('Decoder error (fallback)', error);
        this.onError(new Error(`Decoder error: ${error.message}`));
        this.recoverFromError();
      },
    });

    this.decoder.configure(config);
  }

  /**
   * Attempt to recover from a decoder error.
   *
   * Creates a fresh VideoDecoder instance and reconfigures it with the
   * cached config. Sets waitingForKeyframe so the next keyframe will
   * resume normal decoding. Rate-limited by RECOVERY_COOLDOWN_MS to
   * prevent rapid recovery loops.
   */
  private recoverFromError(): void {
    if (!this.config) {
      this.log.warn('Cannot recover: no cached config');
      return;
    }

    const now = performance.now();
    if (now - this._lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
      return;
    }
    this._lastRecoveryTime = now;

    this.log.info('Attempting decoder recovery...');
    try {
      this.configure(this.config);
      this.log.info('Decoder recovered, waiting for next keyframe');
    } catch (e) {
      this.log.error('Recovery failed', e);
    }
  }

  /**
   * Submit an encoded video chunk for decoding.
   *
   * Implements graduated backpressure:
   * - queue ≤ 2: accept all frames
   * - queue = 3: drop B-frames (small non-keyframes likely to be B-frames)
   * - queue ≥ 4: drop all non-keyframes
   * - queue growing rapidly: proactively drop to prevent further buildup
   *
   * Keyframes are never dropped because they are required for correct
   * decoding of subsequent frames.
   *
   * @param chunk - EncodedVideoChunk to decode
   */
  decode(chunk: EncodedVideoChunk): void {
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.log.warn('Decoder not ready, dropping chunk');
      this._droppedFrames++;
      return;
    }

    // After configure/flush, wait for a keyframe before decoding anything
    if (this._waitingForKeyframe) {
      if (chunk.type !== 'key') {
        this._droppedFrames++;
        return;
      }
      this._waitingForKeyframe = false;
      this.log.info(`First keyframe: ${chunk.byteLength} bytes, ts=${chunk.timestamp}`);
    }

    const queueSize = this.decoder.decodeQueueSize;
    const queueGrowing = queueSize > this._prevQueueSize;
    this._prevQueueSize = queueSize;

    if (chunk.type !== 'key') {
      // Hard threshold: drop all non-keyframes
      if (queueSize >= this._hardThreshold) {
        this._droppedFrames++;
        return;
      }

      // Update rolling average frame size (EMA) for adaptive heuristic
      if (this._frameSizeSamples === 0) {
        this._avgFrameSize = chunk.byteLength;
      } else {
        this._avgFrameSize += (chunk.byteLength - this._avgFrameSize) * VideoStreamDecoder.FRAME_SIZE_ALPHA;
      }
      this._frameSizeSamples++;

      // Soft threshold: drop likely B-frames (small delta frames)
      // B-frames are typically < 25% of the rolling average frame size
      if (queueSize >= this._softThreshold) {
        const bFrameThreshold = Math.max(2048, this._avgFrameSize * 0.25);
        if (chunk.byteLength < bFrameThreshold) {
          this._droppedFrames++;
          return;
        }
      }
      // Proactive: if queue is at normal limit AND growing, drop smallest frames
      if (queueSize > this._normalThreshold && queueGrowing) {
        const proactiveThreshold = Math.max(1024, this._avgFrameSize * 0.15);
        if (chunk.byteLength < proactiveThreshold) {
          this._droppedFrames++;
          return;
        }
      }
    }

    try {
      this._decodeSubmitTimes.push(performance.now());
      // Cap pending timestamps to prevent unbounded growth on stalls
      if (this._decodeSubmitTimes.length > 30) {
        this._decodeSubmitTimes.shift();
      }
      this.decoder.decode(chunk);
    } catch (e) {
      this.log.error('Failed to decode chunk', e);
      this._decodeSubmitTimes.pop(); // remove the timestamp we just pushed
      this._droppedFrames++;
    }
  }

  /**
   * Flush the decoder and reset it to accept new data.
   *
   * Waits for all pending frames to be output, then resets the decoder
   * state. After reset, configure() must be called again before decoding.
   */
  async reset(): Promise<void> {
    if (this.decoder && this.decoder.state === 'configured') {
      try {
        await this.decoder.flush();
        this.decoder.reset();
      } catch {
        // Decoder may already be in error state
      }
    }
    if (this.config && this.decoder && this.decoder.state === 'unconfigured') {
      this.decoder.configure(this.config);
    }
  }

  /**
   * Close the decoder and release all resources.
   *
   * After calling close(), this decoder instance should not be used again.
   */
  close(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Ignore errors closing an already-closed or errored decoder
      }
      this.decoder = null;
    }
    this.log.info('Decoder closed');
  }

  /** Current number of chunks waiting in the decode queue */
  get queueSize(): number {
    if (!this.decoder || this.decoder.state !== 'configured') {
      return 0;
    }
    return this.decoder.decodeQueueSize;
  }

  /** Total number of frames dropped due to backpressure */
  get droppedFrames(): number {
    return this._droppedFrames;
  }

  /** Total number of frames successfully decoded */
  get decodedFrames(): number {
    return this._decodedFrames;
  }

  /** Timestamp (performance.now()) of the last successfully decoded frame */
  get lastDecodeTime(): number {
    return this._lastDecodeTime;
  }

  /** Average decode time in milliseconds (rolling window) */
  get avgDecodeTimeMs(): number {
    if (this._decodeTimeSamples.length === 0) return 0;
    const sum = this._decodeTimeSamples.reduce((a, b) => a + b, 0);
    return sum / this._decodeTimeSamples.length;
  }

  /** Current resolution tier driving backpressure thresholds */
  get resolutionTier(): ResolutionTier {
    return this._resolutionTier;
  }
}
