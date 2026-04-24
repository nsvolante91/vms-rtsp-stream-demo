/**
 * H.264 demuxer shim for WebCodecs.
 *
 * With the bridge now sending AVCC-formatted access units and delivering
 * VideoDecoderConfig via the control channel, this module is a thin adapter:
 * it stores the incoming config and wraps each AVCC frame in an
 * EncodedVideoChunk for the WebCodecs VideoDecoder.
 */

import { Logger } from '../utils/logger';
import type { ReceivedFrame } from './wt-receiver';

/**
 * Thin adapter that accepts VideoDecoderConfig from the control channel
 * and creates EncodedVideoChunk objects from AVCC-format video frames.
 *
 * No NAL unit parsing is performed on the client; the bridge handles all
 * H.264 structural work and delivers ready-to-decode data.
 */
export class H264Demuxer {
  private _config: VideoDecoderConfig | null = null;
  private readonly log: Logger;

  constructor() {
    this.log = new Logger('H264Demuxer');
  }

  /**
   * Store the VideoDecoderConfig received from the bridge control channel.
   *
   * @param config - Ready-to-use config with codec string, dimensions, and avcC description
   */
  configure(config: VideoDecoderConfig): void {
    this._config = config;
    this.log.info(
      `Configured: ${config.codec} ${config.codedWidth}x${config.codedHeight}`
    );
  }

  /**
   * Wrap an AVCC-format video frame in an EncodedVideoChunk.
   *
   * @param frame - Received AVCC frame from the WebTransport receiver
   * @returns EncodedVideoChunk ready for VideoDecoder.decode(), or null if not configured
   */
  createChunk(frame: ReceivedFrame): EncodedVideoChunk | null {
    if (!this._config) {
      return null;
    }

    return new EncodedVideoChunk({
      type: frame.isKeyframe ? 'key' : 'delta',
      timestamp: Number(frame.timestamp),
      data: frame.data,
    });
  }

  /** Whether a VideoDecoderConfig has been received */
  get isConfigured(): boolean {
    return this._config !== null;
  }

  /** Video resolution from the last received config, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    if (!this._config?.codedWidth || !this._config?.codedHeight) {
      return null;
    }
    return { width: this._config.codedWidth, height: this._config.codedHeight };
  }
}

