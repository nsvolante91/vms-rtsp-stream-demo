/**
 * RTSP RTP Source
 *
 * Extends RTPSource to read RTSP camera streams via FFmpeg and output
 * RTP packets to a local UDP port. Uses the auth proxy to work around
 * FFmpeg 8.x SHA-256 Digest auth bugs.
 */

import { RTPSource } from './rtp-source.js';
import {
  createRtspAuthProxy,
  parseRtspUrl,
  type RtspAuthProxy,
} from './rtsp-auth-proxy.js';

/**
 * Reads an RTSP stream via FFmpeg and outputs RTP packets to a local UDP port.
 *
 * FFmpeg handles the RTSP negotiation and RTP packetization. The output
 * RTP packets are standard RFC 6184 H.264 RTP packets that can be
 * forwarded directly to browser clients.
 */
export class RTSPRTPSource extends RTPSource {
  private authProxy: RtspAuthProxy | null = null;
  private proxiedUrl: string = '';

  constructor(private readonly rtspUrl: string) {
    super();
  }

  /** @inheritdoc */
  protected buildFFmpegArgs(port: number): string[] {
    return [
      '-rtsp_transport', 'tcp',
      '-i', this.proxiedUrl,
      '-c:v', 'copy',
      '-an',
      '-f', 'rtp',
      '-loglevel', 'warning',
      `rtp://127.0.0.1:${port}`,
    ];
  }

  /** @inheritdoc */
  protected async onBeforeSpawn(): Promise<void> {
    const { host, port: rtspPort } = parseRtspUrl(this.rtspUrl);
    this.authProxy = await createRtspAuthProxy(host, rtspPort);
    this.proxiedUrl = this.authProxy.rewriteUrl(this.rtspUrl);
    console.log(`[RTSPRTPSource] Using auth proxy: ${this.proxiedUrl}`);
  }

  /** @inheritdoc */
  protected onAfterClose(): void {
    if (this.authProxy) {
      this.authProxy.close();
      this.authProxy = null;
    }
  }
}
