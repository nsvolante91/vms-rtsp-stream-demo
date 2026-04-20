/**
 * RTSP Client
 *
 * Extends FFmpegSource to read RTSP streams via FFmpeg with TCP transport
 * and an auth proxy to work around FFmpeg 8.x SHA-256 Digest auth bugs.
 */

import { spawn } from 'child_process';
import { FFmpegSource } from './ffmpeg-source.js';
import {
  createRtspAuthProxy,
  parseRtspUrl,
  type RtspAuthProxy,
} from './rtsp-auth-proxy.js';

// Re-export NALUEvent from the canonical location
export type { NALUEvent } from './ffmpeg-source.js';

/**
 * Reads an RTSP stream via FFmpeg subprocess and emits parsed H.264 NAL units.
 *
 * Spawns FFmpeg to connect to an RTSP URL using TCP transport, copies the
 * video stream without re-encoding, and outputs raw H.264 Annex B to stdout.
 *
 * @example
 * ```typescript
 * const client = new RTSPClient('rtsp://localhost:8554/stream1');
 * client.on('nalu', (event) => {
 *   console.log(`NAL type ${event.type}, size ${event.nalUnit.length}`);
 * });
 * client.on('sps', (info) => {
 *   console.log(`Stream: ${info.width}x${info.height} ${info.codecString}`);
 * });
 * await client.connect();
 * ```
 */
export class RTSPClient extends FFmpegSource {
  private authProxy: RtspAuthProxy | null = null;
  private proxiedUrl: string = '';

  constructor(private readonly rtspUrl: string) {
    super();
  }

  /** @inheritdoc */
  protected buildFFmpegArgs(): string[] {
    return [
      '-rtsp_transport', 'tcp',
      '-i', this.proxiedUrl,
      '-c:v', 'copy',
      '-an',
      '-f', 'h264',
      '-loglevel', 'warning',
      'pipe:1',
    ];
  }

  /** @inheritdoc */
  protected async onBeforeSpawn(): Promise<void> {
    const { host, port: rtspPort } = parseRtspUrl(this.rtspUrl);
    this.authProxy = await createRtspAuthProxy(host, rtspPort);
    this.proxiedUrl = this.authProxy.rewriteUrl(this.rtspUrl);
    console.log(`[RTSPClient] Using auth proxy: ${this.proxiedUrl}`);
  }

  /** @inheritdoc */
  protected onAfterClose(): void {
    if (this.authProxy) {
      this.authProxy.close();
      this.authProxy = null;
    }
  }
}

/**
 * Probe an RTSP URL to check if a stream is available.
 *
 * Uses ffprobe with a short timeout to test connectivity. Returns stream
 * information if available, null if the stream is not accessible.
 *
 * @param rtspUrl - RTSP URL to probe
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
 * @returns Promise resolving to true if stream is accessible, false otherwise
 */
export async function probeRTSPStream(
  rtspUrl: string,
  timeoutMs = 5000
): Promise<boolean> {
  // Start auth proxy to work around FFmpeg 8.x SHA-256 Digest auth bug
  let proxy: RtspAuthProxy | null = null;
  let proxiedUrl = rtspUrl;
  try {
    const { host, port: rtspPort } = parseRtspUrl(rtspUrl);
    proxy = await createRtspAuthProxy(host, rtspPort);
    proxiedUrl = proxy.rewriteUrl(rtspUrl);
  } catch {
    // If proxy fails to start, try direct connection
  }

  return new Promise<boolean>((resolve) => {
    const proc = spawn('ffprobe', [
      '-rtsp_transport', 'tcp',
      '-analyzeduration', '1000000',
      '-probesize', '1000000',
      '-i', proxiedUrl,
      '-show_streams',
      '-select_streams', 'v:0',
      '-loglevel', 'error',
      '-print_format', 'json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
        proxy?.close();
        resolve(false);
      }
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      proxy?.close();
      if (!resolved) {
        resolved = true;
        if (code === 0 && stdout.length > 0) {
          try {
            const info = JSON.parse(stdout);
            resolve(
              info.streams && info.streams.length > 0
            );
          } catch {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      proxy?.close();
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}
