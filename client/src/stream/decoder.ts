/**
 * WebCodecs VideoDecoder wrapper with backpressure management.
 *
 * Wraps the browser's VideoDecoder API and provides automatic
 * backpressure handling: non-keyframes are dropped when the decode
 * queue is congested, while keyframes are always decoded to prevent
 * stream corruption.
 */

import { Logger } from '../utils/logger';

/** Callback invoked when the decoder outputs a decoded VideoFrame */
export type FrameOutputCallback = (frame: VideoFrame) => void;

/**
 * Graduated backpressure thresholds:
 * - queue ≤ NORMAL_THRESHOLD: accept all frames
 * - queue = SOFT_THRESHOLD: drop B-frames (non-reference delta frames)
 * - queue ≥ HARD_THRESHOLD: drop all non-keyframes
 */
const NORMAL_THRESHOLD = 2;
const SOFT_THRESHOLD = 3;
const HARD_THRESHOLD = 4;

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
   */
  configure(config: VideoDecoderConfig): void {
    this.log.info(`Configuring decoder: ${config.codec} ${config.codedWidth}x${config.codedHeight}`);

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
      output: (frame: VideoFrame) => {
        this._decodedFrames++;
        this._lastDecodeTime = performance.now();
        if (this._decodedFrames <= 3 || this._decodedFrames % 60 === 0) {
          this.log.info(`Frame decoded [stream ${this.streamId}] ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrames})`);
        }
        this.onFrame(frame);
      },
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
      output: (frame: VideoFrame) => {
        this._decodedFrames++;
        this._lastDecodeTime = performance.now();
        if (this._decodedFrames <= 3 || this._decodedFrames % 60 === 0) {
          this.log.info(`Frame decoded [stream ${this.streamId}] ${frame.displayWidth}x${frame.displayHeight} (total: ${this._decodedFrames})`);
        }
        this.onFrame(frame);
      },
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
      if (queueSize >= HARD_THRESHOLD) {
        this._droppedFrames++;
        return;
      }
      // Soft threshold: drop likely B-frames (small delta frames)
      // B-frames are typically much smaller than P-frames
      if (queueSize >= SOFT_THRESHOLD) {
        // Heuristic: B-frames are usually < 25% of keyframe size
        // and the smallest delta frames in a GOP
        if (chunk.byteLength < 2048) {
          this._droppedFrames++;
          return;
        }
      }
      // Proactive: if queue is at normal limit AND growing, start dropping small frames
      if (queueSize > NORMAL_THRESHOLD && queueGrowing && chunk.byteLength < 1024) {
        this._droppedFrames++;
        return;
      }
    }

    try {
      this.decoder.decode(chunk);
    } catch (e) {
      this.log.error('Failed to decode chunk', e);
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
}
