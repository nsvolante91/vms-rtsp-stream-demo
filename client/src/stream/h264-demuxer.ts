/**
 * H.264 demuxer for WebCodecs — RTP Edition.
 *
 * Receives depacketized NAL units from the RTP depacketizer and codec
 * configuration from the server's SDP, then produces EncodedVideoChunk
 * objects suitable for the WebCodecs VideoDecoder API.
 *
 * Unlike the previous Annex B version, this module no longer needs to
 * scan for start codes or parse raw byte streams — the RTP depacketizer
 * handles that. This module focuses on:
 * 1. Building avcC configuration from SPS/PPS
 * 2. Converting NAL units to AVCC format for hardware-accelerated decoding
 * 3. Creating EncodedVideoChunk objects with proper timestamps
 */

import { Logger } from '../utils/logger';
import type { AccessUnit } from './rtp-depacketizer';
import type { CodecConfig } from './wt-receiver';

/**
 * Exp-Golomb bit-level reader for parsing H.264 SPS fields.
 */
class BitReader {
  private readonly data: Uint8Array;
  private byteOffset: number;
  private bitOffset: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.byteOffset = 0;
    this.bitOffset = 0;
  }

  readBit(): number {
    if (this.byteOffset >= this.data.length) {
      throw new Error('BitReader: read past end of data');
    }
    const bit = (this.data[this.byteOffset] >> (7 - this.bitOffset)) & 1;
    this.bitOffset++;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset++;
    }
    return bit;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  readUE(): number {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) {
        throw new Error('BitReader: Exp-Golomb value too large');
      }
    }
    if (leadingZeros === 0) return 0;
    const suffix = this.readBits(leadingZeros);
    return (1 << leadingZeros) - 1 + suffix;
  }

  readSE(): number {
    const value = this.readUE();
    if (value === 0) return 0;
    const sign = (value & 1) === 1 ? 1 : -1;
    return sign * Math.ceil(value / 2);
  }
}

/**
 * Remove emulation prevention bytes (0x03) from NAL unit data.
 */
function removeEmulationPreventionBytes(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (
      i + 2 < data.length &&
      data[i] === 0x00 &&
      data[i + 1] === 0x00 &&
      data[i + 2] === 0x03
    ) {
      result.push(0x00);
      result.push(0x00);
      i += 3;
    } else {
      result.push(data[i]);
      i++;
    }
  }
  return new Uint8Array(result);
}

/** SPS NAL unit type */
const NAL_SPS = 7;
/** PPS NAL unit type */
const NAL_PPS = 8;

/**
 * Build an avcC (AVC Decoder Configuration Record) from SPS and PPS.
 *
 * Required as the `description` field in VideoDecoderConfig for
 * hardware-accelerated H.264 decoding.
 */
function buildAvcC(
  sps: Uint8Array,
  pps: Uint8Array,
  chromaFormat = 1,
  bitDepthLuma = 0,
  bitDepthChroma = 0
): Uint8Array {
  const profileIdc = sps[1];

  const needsExtension =
    profileIdc === 100 || profileIdc === 110 ||
    profileIdc === 122 || profileIdc === 144;
  const extSize = needsExtension ? 4 : 0;

  const size = 6 + 2 + sps.length + 1 + 2 + pps.length + extSize;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let offset = 0;

  buf[offset++] = 1;            // configurationVersion
  buf[offset++] = sps[1];       // AVCProfileIndication
  buf[offset++] = sps[2];       // profile_compatibility
  buf[offset++] = sps[3];       // AVCLevelIndication
  buf[offset++] = 0xff;         // lengthSizeMinusOne = 3 | reserved
  buf[offset++] = 0xe1;         // numSPS = 1 | reserved
  view.setUint16(offset, sps.length, false); offset += 2;
  buf.set(sps, offset); offset += sps.length;
  buf[offset++] = 1;            // numPPS
  view.setUint16(offset, pps.length, false); offset += 2;
  buf.set(pps, offset); offset += pps.length;

  if (needsExtension) {
    buf[offset++] = 0xfc | (chromaFormat & 0x03);
    buf[offset++] = 0xf8 | (bitDepthLuma & 0x07);
    buf[offset++] = 0xf8 | (bitDepthChroma & 0x07);
    buf[offset++] = 0;          // numSPSExt
  }

  return buf;
}

/**
 * Parse SPS NAL unit to extract chroma and bit depth info
 * (needed for avcC High Profile extension bytes).
 */
function parseSPSExtras(sps: Uint8Array): {
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
} {
  const rbsp = removeEmulationPreventionBytes(sps);
  const reader = new BitReader(rbsp.subarray(1));

  const profileIdc = reader.readBits(8);
  reader.readBits(8); // constraint_set_flags
  reader.readBits(8); // level_idc
  reader.readUE();    // seq_parameter_set_id

  let chromaFormatIdc = 1;
  let bitDepthLumaMinus8 = 0;
  let bitDepthChromaMinus8 = 0;

  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = reader.readUE();
    if (chromaFormatIdc === 3) reader.readBit();
    bitDepthLumaMinus8 = reader.readUE();
    bitDepthChromaMinus8 = reader.readUE();
  }

  return { chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8 };
}

/**
 * Check if a NAL unit type is a VCL type (coded picture data).
 */
function isVCLNAL(naluType: number): boolean {
  return naluType >= 1 && naluType <= 5;
}

/**
 * H.264 demuxer for WebCodecs.
 *
 * Receives codec configuration from the server and depacketized access
 * units from the RTP depacketizer, then produces EncodedVideoChunk objects.
 */
export class H264Demuxer {
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private codec: string | null = null;
  private width = 0;
  private height = 0;
  private configured = false;
  private clockRate = 90000;
  private _keyframeLogCount = 0;
  private readonly log: Logger;

  constructor() {
    this.log = new Logger('H264Demuxer');
  }

  /**
   * Process codec configuration received from the server.
   *
   * The server sends SPS/PPS as base64 in a JSON control message (extracted
   * from FFmpeg's SDP output). This builds the VideoDecoderConfig with avcC.
   *
   * @param config - Codec configuration from the server
   * @returns VideoDecoderConfig if successfully built, null otherwise
   */
  processCodecConfig(config: CodecConfig): VideoDecoderConfig | null {
    // Decode base64 SPS/PPS
    const spsBytes = base64ToUint8Array(config.spsB64);
    const ppsBytes = base64ToUint8Array(config.ppsB64);

    if (!spsBytes || !ppsBytes) {
      this.log.error('Failed to decode SPS/PPS from base64');
      return null;
    }

    // Check if config has actually changed
    if (this.configured && this.sps && this.pps) {
      if (bytesEqual(spsBytes, this.sps) && bytesEqual(ppsBytes, this.pps)) {
        return null; // No change
      }
    }

    this.sps = spsBytes;
    this.pps = ppsBytes;
    this.codec = config.codecString;
    this.width = config.width;
    this.height = config.height;
    this.clockRate = config.clockRate;

    this.log.info(`Config: ${this.codec} ${this.width}x${this.height} clockRate=${this.clockRate}`);

    // Parse SPS for chroma/bit depth (needed for avcC High Profile extension)
    let chromaFormat = 1;
    let bitDepthLuma = 0;
    let bitDepthChroma = 0;
    try {
      const extras = parseSPSExtras(spsBytes);
      chromaFormat = extras.chromaFormatIdc;
      bitDepthLuma = extras.bitDepthLumaMinus8;
      bitDepthChroma = extras.bitDepthChromaMinus8;
    } catch {
      // Use defaults
    }

    this.configured = true;
    const description = buildAvcC(
      this.sps,
      this.pps,
      chromaFormat,
      bitDepthLuma,
      bitDepthChroma
    );

    return {
      codec: this.codec,
      codedWidth: this.width,
      codedHeight: this.height,
      description,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
  }

  /**
   * Process SPS/PPS NAL units received inline in RTP packets.
   *
   * Some encoders send SPS/PPS periodically in the RTP stream (typically
   * as STAP-A packets before IDR frames). This handles those in-band
   * parameter sets as a fallback to the SDP-based configuration.
   *
   * @param sps - Raw SPS NAL unit data
   * @param pps - Raw PPS NAL unit data
   * @returns VideoDecoderConfig if config changed, null otherwise
   */
  processInBandConfig(sps: Uint8Array, pps: Uint8Array): VideoDecoderConfig | null {
    if (this.configured && this.sps && this.pps) {
      if (bytesEqual(sps, this.sps) && bytesEqual(pps, this.pps)) {
        return null;
      }
    }

    this.sps = sps;
    this.pps = pps;

    // Build codec string from SPS bytes
    if (sps.length >= 4) {
      const p = sps[1].toString(16).padStart(2, '0');
      const c = sps[2].toString(16).padStart(2, '0');
      const l = sps[3].toString(16).padStart(2, '0');
      this.codec = `avc1.${p}${c}${l}`;
    }

    // Parse SPS for dimensions and chroma info
    let chromaFormat = 1;
    let bitDepthLuma = 0;
    let bitDepthChroma = 0;
    try {
      const extras = parseSPSExtras(sps);
      chromaFormat = extras.chromaFormatIdc;
      bitDepthLuma = extras.bitDepthLumaMinus8;
      bitDepthChroma = extras.bitDepthChromaMinus8;
    } catch {
      // Use defaults
    }

    if (!this.codec) return null;

    this.configured = true;
    const description = buildAvcC(this.sps, this.pps, chromaFormat, bitDepthLuma, bitDepthChroma);

    return {
      codec: this.codec,
      codedWidth: this.width || 1920, // Fallback if dimensions unknown
      codedHeight: this.height || 1080,
      description,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
  }

  /**
   * Create an EncodedVideoChunk from a depacketized access unit.
   *
   * Takes the NAL units from the RTP depacketizer, filters out non-VCL
   * NALs, converts to AVCC format (4-byte length prefix per NAL), and
   * wraps in an EncodedVideoChunk.
   *
   * @param au - Access unit from the RTP depacketizer
   * @returns EncodedVideoChunk ready for the decoder, or null if not configured
   */
  createChunkFromAU(au: AccessUnit): EncodedVideoChunk | null {
    if (!this.configured || !this.sps || !this.pps) {
      return null;
    }

    // Filter to only VCL NAL units (types 1-5)
    const vclNALs = au.nalUnits.filter(n => isVCLNAL(n.type));
    if (vclNALs.length === 0) {
      return null;
    }

    // Convert RTP timestamp (90kHz) to microseconds for WebCodecs
    const timestamp = Math.round((au.timestamp / this.clockRate) * 1_000_000);

    // Build AVCC format: [4-byte BE length][NAL data] for each NAL
    let totalSize = 0;
    for (const nal of vclNALs) {
      totalSize += 4 + nal.data.length;
    }

    const avccData = new Uint8Array(totalSize);
    const view = new DataView(avccData.buffer);
    let offset = 0;

    for (const nal of vclNALs) {
      view.setUint32(offset, nal.data.length, false);
      offset += 4;
      avccData.set(nal.data, offset);
      offset += nal.data.length;
    }

    const type: EncodedVideoChunkType = au.isKeyframe ? 'key' : 'delta';

    // Log first keyframe details
    if (type === 'key' && this._keyframeLogCount < 2) {
      this._keyframeLogCount++;
      this.log.info(`Keyframe AU: ${vclNALs.length} VCL NALs, ${totalSize} bytes, ts=${timestamp}`);
    }

    return new EncodedVideoChunk({
      type,
      timestamp,
      data: avccData,
    });
  }

  /** The parsed AVC codec string, or null if not yet configured */
  get codecString(): string | null {
    return this.codec;
  }

  /** The video resolution, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    if (this.width === 0 || this.height === 0) return null;
    return { width: this.width, height: this.height };
  }

  /** Whether codec configuration has been received */
  get isConfigured(): boolean {
    return this.configured;
  }
}

/**
 * Decode a base64 string to Uint8Array.
 */
function base64ToUint8Array(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Compare two Uint8Arrays for byte-level equality.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
