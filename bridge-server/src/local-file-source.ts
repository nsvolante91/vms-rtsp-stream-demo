/**
 * Local File Source
 *
 * Extends FFmpegSource to demux local MP4 files into H.264 Annex B
 * without re-encoding. Uses FFmpeg's `-c:v copy` with the
 * `h264_mp4toannexb` bitstream filter to convert AVCC to Annex B.
 *
 * Plays back at real-time rate (`-re`) with infinite looping
 * (`-stream_loop -1`) so local files behave like live camera streams.
 */

import { access, constants } from 'fs/promises';
import { spawn } from 'child_process';
import { FFmpegSource } from './ffmpeg-source.js';

export interface LocalFileSourceOptions {
  /** Play at real-time rate (default: true) */
  realtime?: boolean;
  /** Loop the file indefinitely (default: true) */
  loop?: boolean;
}

/**
 * Reads a local MP4 file via FFmpeg and emits parsed H.264 NAL units.
 *
 * No re-encoding — uses codec copy with the h264_mp4toannexb bitstream
 * filter to convert from MP4's AVCC format to raw Annex B byte stream.
 *
 * @example
 * ```typescript
 * const source = new LocalFileSource('/path/to/video.mp4');
 * source.on('nalu', (event) => {
 *   console.log(`NAL type ${event.type}, size ${event.nalUnit.length}`);
 * });
 * await source.connect();
 * ```
 */
export class LocalFileSource extends FFmpegSource {
  private readonly realtime: boolean;
  private readonly loop: boolean;

  constructor(
    private readonly filePath: string,
    options?: LocalFileSourceOptions
  ) {
    super();
    this.realtime = options?.realtime ?? true;
    this.loop = options?.loop ?? true;
  }

  /** @inheritdoc */
  protected buildFFmpegArgs(): string[] {
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
      '-bsf:v', 'h264_mp4toannexb',
      '-an',
      '-f', 'h264',
      '-loglevel', 'warning',
      'pipe:1',
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

  /**
   * Get the file path of this source.
   */
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
        resolve(false);
      }
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (code === 0 && stdout.length > 0) {
          try {
            const info = JSON.parse(stdout);
            const hasH264 = info.streams?.some(
              (s: any) => s.codec_name === 'h264'
            );
            resolve(!!hasH264);
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
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}
