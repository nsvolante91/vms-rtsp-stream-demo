/**
 * H.264 Annex B demuxer for WebCodecs.
 *
 * Parses raw H.264 Annex B byte streams, extracts SPS/PPS configuration
 * data, builds codec strings, and creates EncodedVideoChunk objects
 * suitable for the WebCodecs VideoDecoder API.
 */

import { Logger } from '../utils/logger';
import type { ReceivedFrame } from './wt-receiver';

/**
 * Exp-Golomb bit-level reader for parsing H.264 SPS fields.
 *
 * H.264 SPS data uses Exp-Golomb coding for many fields, requiring
 * bit-level access rather than byte-level reads.
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

  /** Read a single bit from the stream */
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

  /** Read multiple bits as an unsigned integer */
  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  /**
   * Read an unsigned Exp-Golomb coded value (ue(v)).
   * Format: (leadingZeroBits) 1 (suffix of leadingZeroBits bits)
   * Value = 2^leadingZeroBits - 1 + suffix
   */
  readUE(): number {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) {
        throw new Error('BitReader: Exp-Golomb value too large');
      }
    }
    if (leadingZeros === 0) {
      return 0;
    }
    const suffix = this.readBits(leadingZeros);
    return (1 << leadingZeros) - 1 + suffix;
  }

  /**
   * Read a signed Exp-Golomb coded value (se(v)).
   * Maps unsigned values to signed: 0->0, 1->1, 2->-1, 3->2, 4->-2, ...
   */
  readSE(): number {
    const value = this.readUE();
    if (value === 0) return 0;
    const sign = (value & 1) === 1 ? 1 : -1;
    return sign * Math.ceil(value / 2);
  }
}

/**
 * Remove emulation prevention bytes (0x03) from NAL unit data.
 *
 * In H.264 Annex B, the byte sequence 0x000003 prevents false start code
 * detection. The 0x03 byte must be removed before parsing NAL content.
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

/** A NAL unit reference: type + offset/length into the source buffer (zero-copy). */
interface NALURef {
  /** NAL unit type (lower 5 bits of first byte) */
  type: number;
  /** Byte offset of the NAL unit data within the source buffer (after start code) */
  offset: number;
  /** Length of the NAL unit data in bytes */
  length: number;
}

/**
 * Find NAL units in an Annex B byte stream and return offset/length
 * references into the source buffer (no per-NAL Uint8Array allocation).
 */
function findNALUnits(data: Uint8Array): NALURef[] {
  const units: NALURef[] = [];
  const startPositions: { offset: number; len: number }[] = [];

  // Use 3-byte start codes only (0x000001). Never promote to 4-byte
  // (0x00000001) because that steals a trailing 0x00 from the preceding
  // NAL unit. This is critical for PPS: the trailing alignment byte
  // must be preserved for correct avcC description construction.
  for (let i = 0; i < data.length - 2; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      startPositions.push({ offset: i, len: 3 });
      i += 2;
    }
  }

  for (let i = 0; i < startPositions.length; i++) {
    const start = startPositions[i].offset + startPositions[i].len;
    const end = i + 1 < startPositions.length ? startPositions[i + 1].offset : data.length;
    if (start < end) {
      const type = data[start] & 0x1f;
      units.push({ type, offset: start, length: end - start });
    }
  }

  return units;
}

/** SPS NAL unit type */
const NAL_SPS = 7;
/** PPS NAL unit type */
const NAL_PPS = 8;

/**
 * Build an avcC (AVC Decoder Configuration Record) box from SPS and PPS.
 *
 * This is required as the `description` field in VideoDecoderConfig for
 * hardware-accelerated H.264 decoding (e.g., macOS VideoToolbox). Without
 * it, Chrome's hardware decoder rejects Annex B formatted data.
 *
 * Format:
 * ```
 * configurationVersion    = 1
 * AVCProfileIndication     = SPS[1]
 * profile_compatibility    = SPS[2]
 * AVCLevelIndication       = SPS[3]
 * lengthSizeMinusOne       = 3 (0xFF = 4-byte NALU lengths)
 * numSPS                   = 1 (0xE1)
 * spsLength                = uint16BE
 * spsData                  = raw SPS bytes
 * numPPS                   = 1
 * ppsLength                = uint16BE
 * ppsData                  = raw PPS bytes
 * ```
 *
 * @param sps - Raw SPS NAL unit data (including NAL header byte, no start code)
 * @param pps - Raw PPS NAL unit data (including NAL header byte, no start code)
 * @param chromaFormat - chroma_format_idc from SPS (default 1 = 4:2:0)
 * @param bitDepthLuma - bit_depth_luma_minus8 from SPS (default 0 = 8-bit)
 * @param bitDepthChroma - bit_depth_chroma_minus8 from SPS (default 0 = 8-bit)
 * @returns avcC box as Uint8Array
 */
function buildAvcC(
  sps: Uint8Array,
  pps: Uint8Array,
  chromaFormat = 1,
  bitDepthLuma = 0,
  bitDepthChroma = 0
): Uint8Array {
  const profileIdc = sps[1];

  // ISO/IEC 14496-15: High Profile and above require extension bytes
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
  buf[offset++] = 0xff;         // lengthSizeMinusOne = 3 (4-byte lengths) | reserved 6 bits
  buf[offset++] = 0xe1;         // numOfSequenceParameterSets = 1 | reserved 3 bits
  view.setUint16(offset, sps.length, false); offset += 2;
  buf.set(sps, offset); offset += sps.length;
  buf[offset++] = 1;            // numOfPictureParameterSets
  view.setUint16(offset, pps.length, false); offset += 2;
  buf.set(pps, offset); offset += pps.length;

  if (needsExtension) {
    buf[offset++] = 0xfc | (chromaFormat & 0x03);      // reserved 6 bits + chroma_format
    buf[offset++] = 0xf8 | (bitDepthLuma & 0x07);      // reserved 5 bits + bit_depth_luma_minus8
    buf[offset++] = 0xf8 | (bitDepthChroma & 0x07);    // reserved 5 bits + bit_depth_chroma_minus8
    buf[offset++] = 0;                                  // numOfSequenceParameterSetExt
  }

  return buf;
}

/**
 * Convert H.264 Annex B data to AVCC format.
 *
 * Replaces 3- or 4-byte Annex B start codes (0x000001 or 0x00000001)
 * with 4-byte big-endian NALU length prefixes. This format is required
 * when the VideoDecoder is configured with an avcC description.
 *
 * @param annexB - H.264 data with Annex B start codes
 * @returns H.264 data with 4-byte length-prefixed NALUs (AVCC format)
 */
function annexBToAvcc(annexB: Uint8Array): Uint8Array {
  const nalus = findNALUnits(annexB);
  if (nalus.length === 0) return annexB;

  // Calculate total size: 4 bytes length prefix + data for each NALU
  let totalSize = 0;
  for (const nalu of nalus) {
    totalSize += 4 + nalu.length;
  }

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const nalu of nalus) {
    view.setUint32(offset, nalu.length, false);
    offset += 4;
    // Copy NAL data from source buffer using offset/length ref
    result.set(annexB.subarray(nalu.offset, nalu.offset + nalu.length), offset);
    offset += nalu.length;
  }

  return result;
}

/**
 * Check if a NAL unit type is a VCL (Video Coding Layer) type.
 * Only VCL NAL units (types 1-5) contain actual coded picture data.
 * Non-VCL types like AUD (9), SEI (6) must not be sent to the decoder
 * as standalone EncodedVideoChunks.
 */
function isVCLNAL(naluType: number): boolean {
  return naluType >= 1 && naluType <= 5;
}

/**
 * Extract the NAL unit type from Annex B data by skipping the start code prefix.
 */
function extractNALType(data: Uint8Array): number | null {
  if (data.length < 4) return null;

  let headerOffset: number;
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01) {
    headerOffset = 4;
  } else if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01) {
    headerOffset = 3;
  } else {
    return null;
  }

  if (headerOffset >= data.length) return null;
  return data[headerOffset] & 0x1f;
}

/**
 * Parse SPS NAL unit data to extract video dimensions and codec parameters.
 *
 * Handles Baseline, Main, High, and extended profiles. For High profile
 * and above, parses chroma and transform parameters. Correctly handles
 * frame cropping to compute actual video dimensions.
 */
function parseSPS(sps: Uint8Array): { width: number; height: number; profileIdc: number; constraintSetFlags: number; levelIdc: number; chromaFormatIdc: number; bitDepthLumaMinus8: number; bitDepthChromaMinus8: number } {
  const rbsp = removeEmulationPreventionBytes(sps);
  const reader = new BitReader(rbsp.subarray(1)); // skip NAL header

  const profileIdc = reader.readBits(8);
  const constraintSetFlags = reader.readBits(8);
  const levelIdc = reader.readBits(8);

  // seq_parameter_set_id
  reader.readUE();

  let chromaFormatIdc = 1;
  let bitDepthLumaMinus8 = 0;
  let bitDepthChromaMinus8 = 0;
  if (
    profileIdc === 100 || profileIdc === 110 || profileIdc === 122 ||
    profileIdc === 244 || profileIdc === 44 || profileIdc === 83 ||
    profileIdc === 86 || profileIdc === 118 || profileIdc === 128 ||
    profileIdc === 138 || profileIdc === 139 || profileIdc === 134 ||
    profileIdc === 135
  ) {
    chromaFormatIdc = reader.readUE();
    if (chromaFormatIdc === 3) {
      reader.readBit(); // separate_colour_plane_flag
    }
    bitDepthLumaMinus8 = reader.readUE();
    bitDepthChromaMinus8 = reader.readUE();
    reader.readBit(); // qpprime_y_zero_transform_bypass_flag

    const seqScalingMatrixPresentFlag = reader.readBit();
    if (seqScalingMatrixPresentFlag) {
      const scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < scalingListCount; i++) {
        const seqScalingListPresentFlag = reader.readBit();
        if (seqScalingListPresentFlag) {
          const sizeOfScalingList = i < 6 ? 16 : 64;
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < sizeOfScalingList; j++) {
            if (nextScale !== 0) {
              const deltaScale = reader.readSE();
              nextScale = (lastScale + deltaScale + 256) % 256;
            }
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }

  // log2_max_frame_num_minus4
  reader.readUE();

  const picOrderCntType = reader.readUE();
  if (picOrderCntType === 0) {
    reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    reader.readBit(); // delta_pic_order_always_zero_flag
    reader.readSE(); // offset_for_non_ref_pic
    reader.readSE(); // offset_for_top_to_bottom_field
    const numRefFrames = reader.readUE();
    for (let i = 0; i < numRefFrames; i++) {
      reader.readSE(); // offset_for_ref_frame[i]
    }
  }

  reader.readUE(); // max_num_ref_frames
  reader.readBit(); // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbsMinus1 = reader.readUE();
  const picHeightInMapUnitsMinus1 = reader.readUE();
  const frameMbsOnlyFlag = reader.readBit();

  if (!frameMbsOnlyFlag) {
    reader.readBit(); // mb_adaptive_frame_field_flag
  }

  reader.readBit(); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;

  const frameCroppingFlag = reader.readBit();
  if (frameCroppingFlag) {
    cropLeft = reader.readUE();
    cropRight = reader.readUE();
    cropTop = reader.readUE();
    cropBottom = reader.readUE();
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

  return { width, height, profileIdc, constraintSetFlags, levelIdc, chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8 };
}

/**
 * Build an AVC codec string from raw SPS NAL unit bytes.
 *
 * Format: "avc1.XXYYZZ" where:
 * - XX = profile_idc in hex
 * - YY = constraint_set_flags in hex
 * - ZZ = level_idc in hex
 *
 * @param sps - Raw SPS NAL unit data (starting with NAL header byte)
 * @returns Codec string like "avc1.640028"
 */
function buildCodecString(sps: Uint8Array): string {
  if (sps.length < 4) {
    throw new Error('SPS too short to build codec string');
  }
  const profileHex = sps[1].toString(16).padStart(2, '0');
  const constraintHex = sps[2].toString(16).padStart(2, '0');
  const levelHex = sps[3].toString(16).padStart(2, '0');
  return `avc1.${profileHex}${constraintHex}${levelHex}`;
}

/**
 * H.264 Annex B to WebCodecs demuxer.
 *
 * Receives raw H.264 Annex B data, extracts SPS/PPS configuration,
 * determines codec parameters and video dimensions, and produces
 * EncodedVideoChunk objects for the WebCodecs VideoDecoder.
 */
export class H264Demuxer {
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private codec: string | null = null;
  private width = 0;
  private height = 0;
  private chromaFormatIdc = 1;
  private bitDepthLumaMinus8 = 0;
  private bitDepthChromaMinus8 = 0;
  private configured = false;
  private _keyframeLogCount = 0;
  private readonly log: Logger;

  constructor() {
    this.log = new Logger('H264Demuxer');
  }

  /**
   * Process SPS/PPS configuration data from an Annex B byte stream.
   *
   * Extracts SPS and PPS NAL units, parses the SPS to determine
   * codec string and video dimensions, and returns a VideoDecoderConfig
   * suitable for configuring a WebCodecs VideoDecoder.
   *
   * @param data - Raw Annex B data containing SPS and/or PPS NAL units
   * @returns VideoDecoderConfig if SPS was successfully parsed, null otherwise
   */
  processConfig(data: Uint8Array): VideoDecoderConfig | null {
    const nalus = findNALUnits(data);

    let newSps: Uint8Array | null = null;
    let newPps: Uint8Array | null = null;

    for (const nalu of nalus) {
      if (nalu.type === NAL_SPS) {
        newSps = data.slice(nalu.offset, nalu.offset + nalu.length);
      } else if (nalu.type === NAL_PPS) {
        newPps = data.slice(nalu.offset, nalu.offset + nalu.length);
      }
    }

    // If we already have a config and the SPS/PPS haven't changed, skip reconfigure
    if (this.configured) {
      const spsUnchanged = newSps && this.sps && this.bytesEqual(newSps, this.sps);
      const ppsUnchanged = newPps && this.pps && this.bytesEqual(newPps, this.pps);

      if (spsUnchanged && ppsUnchanged) {
        return null;
      }

      // If only one of SPS/PPS was sent and it matches, also skip
      if (!newSps && !newPps) {
        return null;
      }
      if (newSps && !newPps && spsUnchanged) {
        return null;
      }
      if (!newSps && newPps && ppsUnchanged) {
        return null;
      }
    }

    // Something changed (or first time) — update stored SPS/PPS
    if (newSps) {
      this.sps = newSps;
      try {
        const info = parseSPS(newSps);
        this.width = info.width;
        this.height = info.height;
        this.chromaFormatIdc = info.chromaFormatIdc;
        this.bitDepthLumaMinus8 = info.bitDepthLumaMinus8;
        this.bitDepthChromaMinus8 = info.bitDepthChromaMinus8;
        this.codec = buildCodecString(newSps);
        this.log.info(`SPS parsed: ${this.codec}, ${this.width}x${this.height}, chroma=${this.chromaFormatIdc}`);
      } catch (e) {
        this.log.error('Failed to parse SPS', e);
        return null;
      }
    }

    if (newPps) {
      this.pps = newPps;
      this.log.info('PPS received');
    }

    if (this.sps && this.pps && this.codec) {
      this.configured = true;
      const description = buildAvcC(
        this.sps,
        this.pps,
        this.chromaFormatIdc,
        this.bitDepthLumaMinus8,
        this.bitDepthChromaMinus8
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

    return null;
  }

  /** Compare two Uint8Arrays for byte-level equality */
  private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Create an EncodedVideoChunk from a received frame.
   *
   * For keyframes, SPS and PPS NAL units are prepended (with Annex B start
   * codes) so the decoder always has the parameter sets it needs. Without
   * this, the decoder configured in Annex B mode (no description) cannot
   * decode IDR frames because SPS/PPS arrive only in separate config frames.
   *
   * @param frame - Received frame from the WebSocket receiver
   * @returns EncodedVideoChunk ready for the decoder, or null if not configured
   */
  createChunk(frame: ReceivedFrame): EncodedVideoChunk | null {
    if (!this.configured || !this.sps || !this.pps) {
      return null;
    }

    // Only process VCL NAL units (actual picture data: slices).
    // Non-VCL NALs like AUD (type 9) and SEI (type 6) must not be sent
    // to the decoder as standalone EncodedVideoChunks — they are not
    // complete access units and will cause decoder errors or distortion.
    const nalType = extractNALType(frame.data);
    if (nalType === null || !isVCLNAL(nalType)) {
      return null;
    }

    const type: EncodedVideoChunkType = frame.isKeyframe ? 'key' : 'delta';

    // Use microsecond timestamp directly
    const timestamp = Number(frame.timestamp);

    // Convert Annex B to AVCC (length-prefixed NALUs) since the decoder
    // is configured with an avcC description for hardware acceleration
    const data = annexBToAvcc(frame.data);

    // Log first keyframe details for debugging
    if (type === 'key' && this._keyframeLogCount < 2) {
      this._keyframeLogCount++;
      const nalus = findNALUnits(frame.data);
      this.log.info(`Keyframe input: ${frame.data.length} bytes, ${nalus.length} NALUs: [${nalus.map(n => `type=${n.type}:${n.length}b`).join(', ')}]`);
      this.log.info(`AVCC output: ${data.length} bytes, first20=${Array.from(data.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    return new EncodedVideoChunk({
      type,
      timestamp,
      data,
    });
  }

  /** The parsed AVC codec string (e.g., "avc1.640028"), or null if not yet configured */
  get codecString(): string | null {
    return this.codec;
  }

  /** The video resolution from the SPS, or null if not yet configured */
  get resolution(): { width: number; height: number } | null {
    if (this.width === 0 || this.height === 0) {
      return null;
    }
    return { width: this.width, height: this.height };
  }

  /** Whether SPS and PPS have been received and parsed */
  get isConfigured(): boolean {
    return this.configured;
  }
}
