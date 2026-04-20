/**
 * FFmpeg Source — Abstract Base Class
 *
 * Encapsulates the common pattern of spawning an FFmpeg subprocess that
 * outputs raw H.264 Annex B to stdout, parsing the byte stream into
 * individual NAL units, and emitting them as events.
 *
 * Subclasses provide the FFmpeg command-line arguments and any pre/post
 * lifecycle hooks (e.g. RTSP auth proxy, file validation).
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import {
  findNALUnits,
  isKeyframe,
  parseSPS,
  type SPSInfo,
} from './h264-parser.js';

/** Event emitted when a complete NAL unit is extracted from the stream */
export interface NALUEvent {
  /** Raw NAL unit data including NAL header byte */
  nalUnit: Uint8Array;
  /** NAL unit type (5-bit field) */
  type: number;
  /** Timestamp in microseconds from stream start */
  timestamp: bigint;
  /** Whether this NAL unit is an IDR keyframe */
  isKeyframe: boolean;
}

/** Events emitted by FFmpegSource */
export interface FFmpegSourceEvents {
  nalu: (event: NALUEvent) => void;
  sps: (info: SPSInfo) => void;
  error: (error: Error) => void;
  close: () => void;
}

/**
 * Abstract base class for FFmpeg-based H.264 sources.
 *
 * Manages the FFmpeg child process lifecycle, buffers stdout into complete
 * NAL units via Annex B start code scanning, and emits parsed events.
 * Subclasses implement `buildFFmpegArgs()` for source-specific arguments
 * and optional lifecycle hooks.
 */
export abstract class FFmpegSource extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private running = false;
  private frameCount = 0;
  private startTime = 0n;
  private spsInfo: SPSInfo | null = null;

  /**
   * Build the FFmpeg command-line arguments for this source.
   * Must output raw H.264 Annex B to stdout (`pipe:1`).
   */
  protected abstract buildFFmpegArgs(): string[];

  /**
   * Hook called before spawning FFmpeg. Use for setup like auth proxies
   * or file validation. Default implementation is a no-op.
   */
  protected async onBeforeSpawn(): Promise<void> {}

  /**
   * Hook called after FFmpeg process is closed. Use for cleanup like
   * stopping auth proxies. Default implementation is a no-op.
   */
  protected onAfterClose(): void {}

  /**
   * Get the current SPS info if an SPS NAL has been received.
   * @returns Parsed SPS info, or null if not yet available
   */
  getSPSInfo(): SPSInfo | null {
    return this.spsInfo;
  }

  /**
   * Get the total number of frames (NAL units) received.
   * @returns Frame count since connection start
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Check whether the source is currently connected and running.
   * @returns true if FFmpeg process is active
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the FFmpeg process and begin receiving H.264 data.
   *
   * Calls `onBeforeSpawn()` for subclass setup, then spawns FFmpeg
   * with arguments from `buildFFmpegArgs()`. Resolves when the first
   * data arrives on stdout.
   *
   * @throws Error if already connected
   */
  async connect(): Promise<void> {
    if (this.running) {
      throw new Error('FFmpegSource is already connected');
    }

    this.running = true;
    this.frameCount = 0;
    this.startTime = process.hrtime.bigint();
    this.buffer = Buffer.alloc(0);

    await this.onBeforeSpawn();

    const args = this.buildFFmpegArgs();

    return new Promise<void>((resolve, reject) => {
      this.ffmpeg = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;

      this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
        this.onData(chunk);
      });

      this.ffmpeg.stderr!.on('data', (chunk: Buffer) => {
        const message = chunk.toString().trim();
        if (message.length > 0) {
          if (
            message.toLowerCase().includes('error') ||
            message.toLowerCase().includes('fatal')
          ) {
            this.emit('error', new Error(`FFmpeg: ${message}`));
          }
        }
      });

      this.ffmpeg.on('error', (err: Error) => {
        this.running = false;
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
        } else {
          this.emit('error', err);
        }
      });

      this.ffmpeg.on('close', (code: number | null) => {
        this.running = false;
        this.flushBuffer();
        if (!resolved) {
          resolved = true;
          reject(
            new Error(`FFmpeg exited with code ${code} before producing output`)
          );
        }
        this.emit('close');
      });

      // Timeout if FFmpeg doesn't produce output within 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.close();
          reject(new Error('FFmpeg timed out waiting for first output'));
        }
      }, 10000);
    });
  }

  /**
   * Close the connection and kill the FFmpeg process.
   *
   * Sends SIGTERM for graceful shutdown. If the process doesn't exit
   * within 5 seconds, sends SIGKILL. Calls `onAfterClose()` for
   * subclass cleanup.
   */
  close(): void {
    this.running = false;

    this.onAfterClose();

    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;

      proc.kill('SIGTERM');

      const killTimeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
      }, 5000);

      proc.on('close', () => {
        clearTimeout(killTimeout);
      });
    }
  }

  /**
   * Process incoming data from FFmpeg stdout.
   *
   * Appends new data to the internal buffer and extracts complete NAL
   * units by scanning for Annex B 3-byte start codes.
   */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const data = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.length
    );
    const nalUnits = findNALUnits(data);

    if (nalUnits.length === 0) {
      return;
    }

    const lastNALU = nalUnits[nalUnits.length - 1];
    const lastNALUEnd = lastNALU.offset + lastNALU.data.length + 3;

    const completeCount =
      lastNALUEnd < this.buffer.length ? nalUnits.length : nalUnits.length - 1;

    for (let i = 0; i < completeCount; i++) {
      const nalu = nalUnits[i];
      this.emitNALU(nalu.data, nalu.type);
    }

    if (completeCount > 0 && completeCount < nalUnits.length) {
      this.buffer = Buffer.from(this.buffer.subarray(lastNALU.offset));
    } else if (completeCount === nalUnits.length) {
      this.buffer = Buffer.from(this.buffer.subarray(lastNALUEnd));
    }
  }

  /**
   * Flush any remaining NAL units from the buffer.
   * Called when the FFmpeg process exits.
   */
  private flushBuffer(): void {
    if (this.buffer.length === 0) {
      return;
    }

    const data = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.length
    );
    const nalUnits = findNALUnits(data);

    for (const nalu of nalUnits) {
      this.emitNALU(nalu.data, nalu.type);
    }

    this.buffer = Buffer.alloc(0);
  }

  /**
   * Emit a parsed NAL unit event and handle SPS detection.
   */
  private emitNALU(naluData: Uint8Array, type: number): void {
    this.frameCount++;

    const elapsed = process.hrtime.bigint() - this.startTime;
    const timestampUs = elapsed / 1000n;

    if (type === 7) {
      try {
        this.spsInfo = parseSPS(naluData);
        this.emit('sps', this.spsInfo);
      } catch (err) {
        this.emit(
          'error',
          new Error(
            `Failed to parse SPS: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    }

    const event: NALUEvent = {
      nalUnit: new Uint8Array(naluData),
      type,
      timestamp: timestampUs,
      isKeyframe: isKeyframe(type),
    };

    this.emit('nalu', event);
  }
}
