/**
 * Local Stream Source
 *
 * Spawns FFmpeg to read a local video file and output raw H.264 Annex B
 * to stdout. Eliminates the need for MediaMTX / RTSP entirely for local
 * test videos. Implements the same StreamSource interface as RTSPClient
 * so the StreamManager can use either interchangeably.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import {
  findNALUnits,
  isKeyframe,
  parseSPS,
  type SPSInfo,
} from './h264-parser.js';
import type { StreamSource, NALUEvent } from './stream-source.js';

/**
 * Reads a local video file via FFmpeg and emits parsed H.264 NAL units.
 *
 * Spawns FFmpeg with `-stream_loop -1 -re` to loop the file at realtime
 * speed, outputting raw H.264 Annex B to stdout. The parsing logic mirrors
 * RTSPClient exactly — same buffer management, same NAL unit extraction.
 *
 * @example
 * ```typescript
 * const source = new LocalStreamSource('/path/to/video.mp4');
 * source.on('nalu', (event) => {
 *   console.log(`NAL type ${event.type}, size ${event.nalUnit.length}`);
 * });
 * await source.connect();
 * ```
 */
export class LocalStreamSource extends EventEmitter implements StreamSource {
  private ffmpeg: ChildProcess | null = null;
  /** Pre-allocated accumulation buffer — grows by doubling, never shrinks */
  private buffer: Buffer = Buffer.allocUnsafe(1024 * 1024);
  /** Number of valid bytes in the accumulation buffer */
  private bufferFilled = 0;
  /** Offset to start scanning for start codes (avoids rescanning old data) */
  private scanOffset = 0;
  private running = false;
  private frameCount = 0;
  private startTime = 0n;
  private spsInfo: SPSInfo | null = null;

  constructor(private readonly filePath: string) {
    super();
  }

  /** @inheritdoc */
  getSPSInfo(): SPSInfo | null {
    return this.spsInfo;
  }

  /** @inheritdoc */
  getFrameCount(): number {
    return this.frameCount;
  }

  /** @inheritdoc */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the source file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Start FFmpeg to read the local file and begin emitting NAL units.
   *
   * Uses `-re` for realtime pacing and `-stream_loop -1` for infinite
   * looping. If the source is already H.264, uses codec copy (zero CPU).
   * Otherwise re-encodes with libx264 ultrafast.
   *
   * @throws Error if already connected
   */
  async connect(): Promise<void> {
    if (this.running) {
      throw new Error('LocalStreamSource is already connected');
    }

    this.running = true;
    this.frameCount = 0;
    this.startTime = process.hrtime.bigint();
    this.bufferFilled = 0;
    this.scanOffset = 0;

    // Probe codec to decide copy vs re-encode
    const isH264 = await this.probeIsH264();

    const ffmpegArgs = [
      '-re',
      '-stream_loop', '-1',
      '-i', this.filePath,
      ...(isH264
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-g', '60']),
      '-an',
      '-f', 'h264',
      '-flush_packets', '1',
      '-fflags', '+nobuffer+flush_packets',
      '-avioflags', 'direct',
      '-loglevel', 'warning',
      'pipe:1',
    ];

    console.log(`[LocalSource] Spawning FFmpeg for ${this.filePath} (${isH264 ? 'copy' : 're-encode'})`);

    return new Promise<void>((resolve, reject) => {
      this.ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      let connectTimeout: ReturnType<typeof setTimeout> | null = null;

      this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
        if (!resolved) {
          resolved = true;
          if (connectTimeout) clearTimeout(connectTimeout);
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
      connectTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.close();
          reject(new Error(`FFmpeg timed out reading ${this.filePath}`));
        }
      }, 10000);
    });
  }

  /** No-op — see RTSPClient.pause() for rationale. */
  pause(): void {
    // Intentionally a no-op
  }

  /** No-op — see RTSPClient.resume() for rationale. */
  resume(): void {
    // Intentionally a no-op
  }

  /**
   * Stop FFmpeg and release resources.
   */
  close(): void {
    this.running = false;

    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;

      proc.kill('SIGTERM');

      const killTimeout = setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        } catch {
          // Process may have already exited
        }
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(killTimeout);
      });
    }
  }

  /**
   * Probe whether the source file contains H.264 video.
   * Falls back to re-encode if ffprobe fails.
   */
  private probeIsH264(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'csv=p=0',
        this.filePath,
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let output = '';
      probe.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      probe.on('close', () => {
        resolve(output.trim().split('\n')[0] === 'h264');
      });

      probe.on('error', () => {
        resolve(false);
      });

      // Timeout — assume not H.264
      setTimeout(() => {
        try { probe.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 5000);
    });
  }

  /**
   * Process incoming data from FFmpeg stdout.
   * Identical buffer/NAL parsing strategy as RTSPClient.
   */
  private onData(chunk: Buffer): void {
    const needed = this.bufferFilled + chunk.length;
    if (needed > this.buffer.length) {
      const newSize = Math.max(this.buffer.length * 2, needed);
      const newBuf = Buffer.allocUnsafe(newSize);
      if (this.bufferFilled > 0) {
        this.buffer.copy(newBuf, 0, 0, this.bufferFilled);
      }
      this.buffer = newBuf;
    }

    chunk.copy(this.buffer, this.bufferFilled);
    this.bufferFilled += chunk.length;

    const data = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.bufferFilled
    );
    const nalUnits = findNALUnits(data, this.scanOffset);

    if (nalUnits.length === 0) {
      return;
    }

    const lastNALU = nalUnits[nalUnits.length - 1];
    const lastNALUEnd = lastNALU.offset + lastNALU.data.length + 3; // 3-byte start code

    const completeCount =
      lastNALUEnd < this.bufferFilled ? nalUnits.length : nalUnits.length - 1;

    for (let i = 0; i < completeCount; i++) {
      const nalu = nalUnits[i];
      this.emitNALU(nalu.data, nalu.type);
    }

    if (completeCount > 0 && completeCount < nalUnits.length) {
      const keepFrom = lastNALU.offset;
      const remaining = this.bufferFilled - keepFrom;
      this.buffer.copyWithin(0, keepFrom, this.bufferFilled);
      this.bufferFilled = remaining;
      this.scanOffset = 0;
    } else if (completeCount === nalUnits.length) {
      const remaining = this.bufferFilled - lastNALUEnd;
      if (remaining > 0) {
        this.buffer.copyWithin(0, lastNALUEnd, this.bufferFilled);
      }
      this.bufferFilled = remaining;
      this.scanOffset = 0;
    } else {
      this.scanOffset = Math.max(0, this.bufferFilled - 2);
    }
  }

  /**
   * Flush remaining NAL units from the buffer on close.
   */
  private flushBuffer(): void {
    if (this.bufferFilled === 0) return;

    const data = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.bufferFilled
    );
    const nalUnits = findNALUnits(data);

    for (const nalu of nalUnits) {
      this.emitNALU(nalu.data, nalu.type);
    }

    this.bufferFilled = 0;
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
