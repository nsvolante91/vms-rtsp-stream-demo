/**
 * Stream pipeline orchestrating the full decode chain for a single stream.
 *
 * Connects the WebTransport receiver, H.264 demuxer, and WebCodecs decoder
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
  /** Register a per-stream callback for VideoDecoderConfig from the control channel */
  onStreamConfig(streamId: number, callback: (config: VideoDecoderConfig) => void): void;
}

/**
 * Full decode pipeline for a single video stream.
 *
 * Subscribes to the shared WTReceiver for its stream, demuxes incoming
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

  /**
   * Create a new StreamPipeline.
   * @param streamId - Numeric stream identifier
   * @param receiver - Shared stream receiver instance (WebTransport)
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
   * Creates the decoder, subscribes to the receiver for this stream's
   * data, and begins processing incoming frames through the
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

    // Wire config from the control channel → demuxer + decoder
    this.receiver.onStreamConfig(this.streamId, (config: VideoDecoderConfig) => {
      this.demuxer.configure(config);
      if (this.decoder) {
        this.decoder.configure(config);
      }
    });

    this.receiver.subscribe(this.streamId, (frame: ReceivedFrame) => {
      this.handleReceivedFrame(frame);
    });

    this.log.info('Pipeline started');
  }

  /**
   * Stop the decode pipeline.
   *
   * Unsubscribes from the receiver and closes the decoder.
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
   * Handle a frame received from the transport.
   *
   * Config is now delivered via the control channel (not as video frames),
   * so all frames here are AVCC-format video data ready for the decoder.
   */
  private handleReceivedFrame(frame: ReceivedFrame): void {
    if (!this.demuxer.isConfigured || !this.decoder) {
      return;
    }

    const chunk = this.demuxer.createChunk(frame);
    if (chunk) {
      this.decoder.decode(chunk);
    }
  }

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
