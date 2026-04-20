/**
 * Local File RTP Source
 *
 * Extends RTPSource to demux local MP4 files into RTP packets via FFmpeg.
 * Uses FFmpeg's `-f rtp` output to generate standard H.264 RTP packets
 * (RFC 6184) from local video files without re-encoding.
 *
 * Plays back at real-time rate (`-re`) with infinite looping
 * (`-stream_loop -1`) so local files behave like live camera streams.
 */

import { access, constants } from 'fs/promises';
import { spawn } from 'child_process';
import { RTPSource } from './rtp-source.js';

export interface LocalRTPSourceOptions {
  /** Play at real-time rate (default: true) */
  realtime?: boolean;
  /** Loop the file indefinitely (default: true) */
  loop?: boolean;
}

/**
 * Reads a local MP4 file via FFmpeg and outputs RTP packets to a local UDP port.
 *
 * No re-encoding — uses codec copy. FFmpeg handles H.264 RTP packetization
 * (RFC 6184) including FU-A fragmentation for large NAL units.
 */
export class LocalRTPSource extends RTPSource {
  private readonly realtime: boolean;
  private readonly loop: boolean;

  constructor(
    private readonly filePath: string,
    options?: LocalRTPSourceOptions
  ) {
    super();
    this.realtime = options?.realtime ?? true;
    this.loop = options?.loop ?? true;
  }

  /** @inheritdoc */
  protected buildFFmpegArgs(port: number): string[] {
    const args: string[] = [];

    if (this.realtime) {
      args.push('-re');
    }

    if (this.loop) {
      args.push('-stream_loop', '-1');
    }

    args.push(
      '-i', this.filePath,
      '-c:v', 'copy',
      '-an',
      '-f', 'rtp',
      '-loglevel', 'warning',
      `rtp://127.0.0.1:${port}`,
    );

    return args;
  }

  /** @inheritdoc */
  protected async onBeforeSpawn(): Promise<void> {
    try {
      await access(this.filePath, constants.R_OK);
    } catch {
      throw new Error(`Local file not readable: ${this.filePath}`);
    }
  }

  /** Get the file path of this source */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Probe a local video file to check if it contains H.264 video.
 *
 * Uses ffprobe to inspect the file's video codec. Returns true only
 * if the file contains an H.264 (AVC) video stream.
 *
 * @param filePath - Path to the video file
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
 * @returns Promise resolving to true if file contains H.264 video
 */
export async function probeLocalFile(
  filePath: string,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('ffprobe', [
      '-i', filePath,
      '-show_streams',
      '-select_streams', 'v:0',
      '-loglevel', 'error',
      '-print_format', 'json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        resolve(false);
      }
    }, timeoutMs);

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;

      try {
        const data = JSON.parse(stdout);
        const streams = data.streams ?? [];
        const hasH264 = streams.some(
          (s: { codec_name?: string; codec_type?: string }) =>
            s.codec_type === 'video' && s.codec_name === 'h264'
        );
        resolve(hasH264);
      } catch {
        resolve(false);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}
