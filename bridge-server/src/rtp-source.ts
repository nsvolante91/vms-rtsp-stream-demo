/**
 * RTP Source — Abstract Base Class
 *
 * Spawns an FFmpeg subprocess that outputs RTP packets to a local UDP port.
 * Captures those packets via a Node.js UDP socket and emits them as events.
 * Also captures the SDP output from FFmpeg to extract SPS/PPS and codec info.
 *
 * Subclasses provide the FFmpeg command-line arguments for their source type.
 * The server forwards raw RTP packets to clients — no H.264 parsing needed.
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { createSocket, Socket as UDPSocket } from 'dgram';

/** Parsed SDP information from FFmpeg's RTP output */
export interface SDPInfo {
  /** Base64-encoded SPS from sprop-parameter-sets */
  spsB64: string;
  /** Base64-encoded PPS from sprop-parameter-sets */
  ppsB64: string;
  /** Raw SPS NAL unit bytes */
  sps: Uint8Array;
  /** Raw PPS NAL unit bytes */
  pps: Uint8Array;
  /** Codec string (e.g., "avc1.640028") from profile-level-id */
  codecString: string;
  /** Video width from SPS parsing */
  width: number;
  /** Video height from SPS parsing */
  height: number;
  /** RTP payload type number */
  payloadType: number;
  /** RTP clock rate (typically 90000 for H.264 video) */
  clockRate: number;
}

/** Event emitted when an RTP packet is received on the UDP socket */
export interface RTPPacketEvent {
  /** Raw RTP packet bytes (including RTP header) */
  packet: Buffer;
  /** Size of the packet in bytes */
  size: number;
}

/** Events emitted by RTPSource */
export interface RTPSourceEvents {
  /** Emitted for each received RTP packet */
  rtp: (event: RTPPacketEvent) => void;
  /** Emitted when SDP is parsed and codec info is available */
  sdp: (info: SDPInfo) => void;
  /** Emitted on error */
  error: (error: Error) => void;
  /** Emitted when the source closes */
  close: () => void;
}

/**
 * Parse SPS NAL unit to extract video dimensions.
 * Minimal parser — just enough to get width/height.
 */
function parseSPSDimensions(sps: Uint8Array): { width: number; height: number } {
  // Remove emulation prevention bytes
  const rbsp: number[] = [];
  let i = 0;
  while (i < sps.length) {
    if (
      i + 2 < sps.length &&
      sps[i] === 0x00 &&
      sps[i + 1] === 0x00 &&
      sps[i + 2] === 0x03
    ) {
      rbsp.push(0x00);
      rbsp.push(0x00);
      i += 3;
    } else {
      rbsp.push(sps[i]);
      i++;
    }
  }

  const data = new Uint8Array(rbsp);
  let byteOff = 1; // skip NAL header
  let bitOff = 0;

  function readBit(): number {
    if (byteOff >= data.length) return 0;
    const bit = (data[byteOff] >> (7 - bitOff)) & 1;
    bitOff++;
    if (bitOff === 8) { bitOff = 0; byteOff++; }
    return bit;
  }

  function readBits(n: number): number {
    let v = 0;
    for (let j = 0; j < n; j++) v = (v << 1) | readBit();
    return v;
  }

  function readUE(): number {
    let zeros = 0;
    while (readBit() === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + readBits(zeros);
  }

  function readSE(): number {
    const v = readUE();
    if (v === 0) return 0;
    return (v & 1) === 1 ? Math.ceil(v / 2) : -Math.ceil(v / 2);
  }

  const profileIdc = readBits(8);
  readBits(8); // constraint_set_flags
  readBits(8); // level_idc
  readUE(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = readUE();
    if (chromaFormatIdc === 3) readBit();
    readUE(); // bit_depth_luma_minus8
    readUE(); // bit_depth_chroma_minus8
    readBit(); // qpprime_y_zero_transform_bypass_flag
    if (readBit()) { // seq_scaling_matrix_present_flag
      const cnt = chromaFormatIdc !== 3 ? 8 : 12;
      for (let j = 0; j < cnt; j++) {
        if (readBit()) {
          const size = j < 6 ? 16 : 64;
          let last = 8, next = 8;
          for (let k = 0; k < size; k++) {
            if (next !== 0) { next = (last + readSE() + 256) % 256; }
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }

  readUE(); // log2_max_frame_num_minus4
  const pocType = readUE();
  if (pocType === 0) {
    readUE();
  } else if (pocType === 1) {
    readBit();
    readSE();
    readSE();
    const n = readUE();
    for (let j = 0; j < n; j++) readSE();
  }

  readUE(); // max_num_ref_frames
  readBit(); // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbsMinus1 = readUE();
  const picHeightInMapUnitsMinus1 = readUE();
  const frameMbsOnlyFlag = readBit();

  if (!frameMbsOnlyFlag) readBit();
  readBit(); // direct_8x8_inference_flag

  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (readBit()) { // frame_cropping_flag
    cropLeft = readUE();
    cropRight = readUE();
    cropTop = readUE();
    cropBottom = readUE();
  }

  let cropUnitX = 1;
  let cropUnitY = 2 - frameMbsOnlyFlag;
  if (chromaFormatIdc === 1) {
    cropUnitX = 2;
    cropUnitY = 2 * (2 - frameMbsOnlyFlag);
  } else if (chromaFormatIdc === 2) {
    cropUnitX = 2;
    cropUnitY = 2 - frameMbsOnlyFlag;
  }

  const width = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - cropUnitY * (cropTop + cropBottom);

  return { width, height };
}

/**
 * Parse the SDP output from FFmpeg to extract H.264 codec parameters.
 *
 * Looks for the `sprop-parameter-sets` attribute (base64-encoded SPS/PPS)
 * and `profile-level-id` for the codec string.
 */
function parseSDPFromFFmpeg(sdpText: string): SDPInfo | null {
  // Extract sprop-parameter-sets
  const spropMatch = sdpText.match(/sprop-parameter-sets=([A-Za-z0-9+/=]+),([A-Za-z0-9+/=]+)/);
  if (!spropMatch) return null;

  const spsB64 = spropMatch[1];
  const ppsB64 = spropMatch[2];
  const sps = Buffer.from(spsB64, 'base64');
  const pps = Buffer.from(ppsB64, 'base64');

  // Extract profile-level-id (or derive from SPS)
  let codecString: string;
  const plMatch = sdpText.match(/profile-level-id=([0-9A-Fa-f]{6})/);
  if (plMatch) {
    codecString = `avc1.${plMatch[1].toLowerCase()}`;
  } else if (sps.length >= 4) {
    const p = sps[1].toString(16).padStart(2, '0');
    const c = sps[2].toString(16).padStart(2, '0');
    const l = sps[3].toString(16).padStart(2, '0');
    codecString = `avc1.${p}${c}${l}`;
  } else {
    codecString = 'avc1.640028'; // fallback
  }

  // Extract payload type
  const ptMatch = sdpText.match(/a=rtpmap:(\d+)\s+H264\/(\d+)/i);
  const payloadType = ptMatch ? parseInt(ptMatch[1], 10) : 96;
  const clockRate = ptMatch ? parseInt(ptMatch[2], 10) : 90000;

  // Parse SPS for dimensions
  let width = 0;
  let height = 0;
  try {
    const dims = parseSPSDimensions(sps);
    width = dims.width;
    height = dims.height;
  } catch {
    // Dimensions unknown until first frames arrive
  }

  return {
    spsB64,
    ppsB64,
    sps: new Uint8Array(sps),
    pps: new Uint8Array(pps),
    codecString,
    width,
    height,
    payloadType,
    clockRate,
  };
}

/** Port range for local UDP RTP listeners */
let nextPort = 15000;

/**
 * Allocate the next available local UDP port for RTP reception.
 * Uses a simple incrementing counter to avoid port conflicts.
 */
function allocatePort(): number {
  const port = nextPort;
  nextPort += 2; // RTP uses even ports, RTCP uses odd (port+1)
  if (nextPort > 60000) nextPort = 15000;
  return port;
}

/**
 * Abstract base class for RTP-based video sources.
 *
 * Spawns FFmpeg to output RTP packets to a local UDP port, then captures
 * those packets and emits them as events. The server forwards raw RTP
 * packets to browser clients without any H.264 parsing.
 */
export abstract class RTPSource extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private udpSocket: UDPSocket | null = null;
  private running = false;
  private packetCount = 0;
  private sdpInfo: SDPInfo | null = null;
  protected rtpPort: number = 0;

  /**
   * Build the FFmpeg command-line arguments for this source.
   * Must output RTP to `rtp://127.0.0.1:{port}`.
   * @param port - Local UDP port to send RTP packets to
   */
  protected abstract buildFFmpegArgs(port: number): string[];

  /**
   * Hook called before spawning FFmpeg.
   */
  protected async onBeforeSpawn(): Promise<void> {}

  /**
   * Hook called after FFmpeg process closes.
   */
  protected onAfterClose(): void {}

  /** Get the parsed SDP info, or null if not yet available */
  getSDPInfo(): SDPInfo | null {
    return this.sdpInfo;
  }

  /** Get the total number of RTP packets received */
  getPacketCount(): number {
    return this.packetCount;
  }

  /** Check whether the source is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the FFmpeg process and begin receiving RTP packets.
   *
   * 1. Allocates a local UDP port
   * 2. Creates a UDP socket to receive RTP packets
   * 3. Calls `onBeforeSpawn()` for subclass setup
   * 4. Spawns FFmpeg with RTP output to the local UDP port
   * 5. Parses SDP from FFmpeg stderr
   * 6. Resolves when first RTP packet arrives
   */
  async connect(): Promise<void> {
    if (this.running) {
      throw new Error('RTPSource is already connected');
    }

    this.running = true;
    this.packetCount = 0;
    this.rtpPort = allocatePort();

    await this.onBeforeSpawn();

    // Create UDP socket to receive RTP packets from FFmpeg
    const udpSocket = createSocket('udp4');
    this.udpSocket = udpSocket;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      let sdpBuffer = '';

      // Bind UDP socket
      udpSocket.bind(this.rtpPort, '127.0.0.1', () => {
        console.log(`[RTPSource] UDP socket listening on 127.0.0.1:${this.rtpPort}`);

        // Spawn FFmpeg
        const args = this.buildFFmpegArgs(this.rtpPort);
        this.ffmpeg = spawn('ffmpeg', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Capture SDP from FFmpeg stdout (FFmpeg prints SDP when using -f rtp)
        this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
          sdpBuffer += chunk.toString();
          if (!this.sdpInfo) {
            this.tryParseSDP(sdpBuffer);
          }
        });

        // Also check stderr for SDP and errors
        this.ffmpeg.stderr!.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          sdpBuffer += text;

          if (!this.sdpInfo) {
            this.tryParseSDP(sdpBuffer);
          }

          // Log FFmpeg errors
          if (text.toLowerCase().includes('error') || text.toLowerCase().includes('fatal')) {
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              this.emit('error', new Error(`FFmpeg: ${trimmed}`));
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
          if (!resolved) {
            resolved = true;
            reject(new Error(`FFmpeg exited with code ${code} before producing RTP output`));
          }
          this.emit('close');
        });
      });

      // Handle incoming RTP packets
      udpSocket.on('message', (msg: Buffer) => {
        this.packetCount++;

        if (!resolved) {
          resolved = true;
          resolve();
        }

        this.emit('rtp', { packet: msg, size: msg.length } as RTPPacketEvent);
      });

      udpSocket.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`UDP socket error: ${err.message}`));
        } else {
          this.emit('error', err);
        }
      });

      // Timeout if no RTP packets within 15 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.close();
          reject(new Error('FFmpeg timed out waiting for first RTP packet'));
        }
      }, 15000);
    });
  }

  /**
   * Attempt to parse SDP from accumulated FFmpeg output.
   */
  private tryParseSDP(text: string): void {
    const info = parseSDPFromFFmpeg(text);
    if (info) {
      this.sdpInfo = info;
      console.log(
        `[RTPSource] SDP parsed: ${info.codecString} ${info.width}x${info.height} PT=${info.payloadType}`
      );
      this.emit('sdp', info);
    }
  }

  /**
   * Close the connection, kill FFmpeg, and close the UDP socket.
   */
  close(): void {
    this.running = false;
    this.onAfterClose();

    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // Already closed
      }
      this.udpSocket = null;
    }

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
}
