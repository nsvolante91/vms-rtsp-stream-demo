/**
 * RTSP Client
 *
 * Uses FFmpeg as a child process to read RTSP streams and output raw H.264
 * Annex B byte streams. Parses the output into individual NAL units and
 * emits them as events for downstream consumers.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import {
  findNALUnits,
  getNALUnitType,
  isKeyframe,
  isConfigNAL,
  parseSPS,
  type SPSInfo,
} from './h264-parser.js';
import {
  createRtspAuthProxy,
  parseRtspUrl,
  type RtspAuthProxy,
} from './rtsp-auth-proxy.js';

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

/** Events emitted by RTSPClient */
export interface RTSPClientEvents {
  nalu: (event: NALUEvent) => void;
  sps: (info: SPSInfo) => void;
  error: (error: Error) => void;
  close: () => void;
}

/**
 * Reads an RTSP stream via FFmpeg subprocess and emits parsed H.264 NAL units.
 *
 * Spawns FFmpeg to connect to an RTSP URL using TCP transport, copies the
 * video stream without re-encoding, and outputs raw H.264 Annex B to stdout.
 * The stdout buffer is continuously parsed for NAL unit start codes, and
 * complete NAL units are emitted as events.
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
export class RTSPClient extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private running = false;
  private frameCount = 0;
  private startTime = 0n;
  private spsInfo: SPSInfo | null = null;
  private authProxy: RtspAuthProxy | null = null;

  constructor(private readonly rtspUrl: string) {
    super();
  }

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
   * Check whether the client is currently connected and running.
   * @returns true if FFmpeg process is active
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Connect to the RTSP stream and begin receiving H.264 data.
   *
   * Spawns an FFmpeg process that reads from the RTSP URL via TCP transport,
   * copies the video codec (no transcoding), strips audio, and outputs raw
   * H.264 Annex B format to stdout. The stdout stream is parsed in real-time
   * for NAL unit boundaries.
   *
   * @throws Error if already connected
   */
  async connect(): Promise<void> {
    if (this.running) {
      throw new Error('RTSPClient is already connected');
    }

    this.running = true;
    this.frameCount = 0;
    this.startTime = process.hrtime.bigint();
    this.buffer = Buffer.alloc(0);

    // Start auth proxy to work around FFmpeg 8.x SHA-256 Digest auth bug
    const { host, port: rtspPort } = parseRtspUrl(this.rtspUrl);
    this.authProxy = await createRtspAuthProxy(host, rtspPort);
    const proxiedUrl = this.authProxy.rewriteUrl(this.rtspUrl);
    console.log(`[RTSPClient] Using auth proxy: ${proxiedUrl}`);

    return new Promise<void>((resolve, reject) => {
      // Spawn FFmpeg: read RTSP via TCP, output raw H.264 Annex B to stdout
      this.ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', proxiedUrl,
        '-c:v', 'copy',
        '-an',
        '-f', 'h264',
        '-loglevel', 'warning',
        'pipe:1',
      ], {
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
          // FFmpeg warnings/errors go to stderr; only emit as error if severe
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
        // Flush any remaining buffer
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
          reject(new Error(`FFmpeg timed out connecting to ${this.rtspUrl}`));
        }
      }, 10000);
    });
  }

  /**
   * Close the connection and kill the FFmpeg process.
   *
   * Sends SIGTERM to the FFmpeg process for graceful shutdown.
   * If the process doesn't exit within 5 seconds, sends SIGKILL.
   */
  close(): void {
    this.running = false;

    // Shut down the auth proxy
    if (this.authProxy) {
      this.authProxy.close();
      this.authProxy = null;
    }

    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;

      // Try graceful shutdown first
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if still alive
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
   * Appends new data to the internal buffer and attempts to extract
   * complete NAL units by scanning for Annex B start codes. Complete
   * NAL units are emitted as events; incomplete data remains in the buffer
   * for the next chunk.
   *
   * @param chunk - Raw bytes from FFmpeg stdout
   */
  private onData(chunk: Buffer): void {
    // Append new data to buffer
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Find all NAL units in the current buffer
    const data = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.length
    );
    const nalUnits = findNALUnits(data);

    if (nalUnits.length === 0) {
      return;
    }

    // Keep the data from the last start code onward in the buffer,
    // since the last NAL unit might be incomplete
    const lastNALU = nalUnits[nalUnits.length - 1];
    const lastNALUEnd = lastNALU.offset + lastNALU.data.length +
      this.getStartCodeLength(data, lastNALU.offset);

    // Emit all NAL units except possibly the last one (which may be incomplete)
    // We can tell a NAL unit is complete if there's a start code after it
    const completeCount =
      lastNALUEnd < this.buffer.length ? nalUnits.length : nalUnits.length - 1;

    for (let i = 0; i < completeCount; i++) {
      const nalu = nalUnits[i];
      this.emitNALU(nalu.data, nalu.type);
    }

    // Keep remaining data in buffer
    if (completeCount > 0 && completeCount < nalUnits.length) {
      // Keep from the last NAL unit's start code position onward
      this.buffer = Buffer.from(this.buffer.subarray(lastNALU.offset));
    } else if (completeCount === nalUnits.length) {
      // All NAL units were complete; keep any trailing data after the last one
      this.buffer = Buffer.from(this.buffer.subarray(lastNALUEnd));
    }
    // If completeCount === 0, keep the entire buffer
  }

  /**
   * Get the start code length at a given offset.
   *
   * Always returns 3 to match the 3-byte-only detection used by
   * findNALUnits. This preserves trailing zero bytes as part of the
   * preceding NAL unit rather than consuming them into a 4-byte start code.
   *
   * @returns 3 (always uses 3-byte start code detection)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private getStartCodeLength(_data: Uint8Array, _offset: number): number {
    return 3;
  }

  /**
   * Flush any remaining NAL units from the buffer.
   * Called when the FFmpeg process exits to ensure no data is lost.
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
   *
   * @param naluData - Raw NAL unit data
   * @param type - NAL unit type
   */
  private emitNALU(naluData: Uint8Array, type: number): void {
    this.frameCount++;

    const elapsed = process.hrtime.bigint() - this.startTime;
    // Convert nanoseconds to microseconds
    const timestampUs = elapsed / 1000n;

    // If this is an SPS, parse it and emit sps event
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
