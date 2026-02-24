/**
 * H.264 NAL Unit Parser
 *
 * Parses H.264 Annex B byte streams into individual NAL units,
 * extracts SPS parameters for codec configuration, and provides
 * utilities for identifying NAL unit types.
 */

/** A single NAL unit extracted from an Annex B byte stream */
export interface NALUnit {
  /** NAL unit type (5-bit field from first byte) */
  type: number;
  /** Raw NAL unit data including the NAL header byte */
  data: Uint8Array;
  /** Byte offset in the source buffer where this NAL unit starts */
  offset: number;
}

/** Parsed Sequence Parameter Set information */
export interface SPSInfo {
  /** H.264 profile indicator (e.g., 100 for High Profile) */
  profileIdc: number;
  /** Constraint set flags byte */
  constraintSetFlags: number;
  /** H.264 level indicator (e.g., 40 for Level 4.0) */
  levelIdc: number;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Codec string in "avc1.XXYYZZ" format */
  codecString: string;
}

/**
 * Bit-level reader for parsing Exp-Golomb coded values in H.264 SPS.
 *
 * H.264 SPS data uses Exp-Golomb coding for many fields, which requires
 * reading individual bits rather than whole bytes.
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

  /**
   * Read a single bit from the stream.
   * @returns 0 or 1
   */
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

  /**
   * Read multiple bits as an unsigned integer.
   * @param count - Number of bits to read
   * @returns Unsigned integer value
   */
  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  /**
   * Read an unsigned Exp-Golomb coded value (ue(v)).
   *
   * Format: (leadingZeroBits) 1 (suffix of leadingZeroBits bits)
   * Value = 2^leadingZeroBits - 1 + suffix
   * @returns Decoded unsigned integer
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
   *
   * Maps unsigned values to signed: 0->0, 1->1, 2->-1, 3->2, 4->-2, ...
   * @returns Decoded signed integer
   */
  readSE(): number {
    const value = this.readUE();
    if (value === 0) return 0;
    const sign = (value & 1) === 1 ? 1 : -1;
    return sign * Math.ceil(value / 2);
  }

  /**
   * Skip a specified number of bits.
   * @param count - Number of bits to skip
   */
  skipBits(count: number): void {
    for (let i = 0; i < count; i++) {
      this.readBit();
    }
  }
}

/**
 * Remove emulation prevention bytes (0x03) from NAL unit data.
 *
 * In H.264 Annex B, the byte sequence 0x000003 is used to prevent
 * false start code detection. The 0x03 byte must be removed before
 * parsing the NAL unit content.
 *
 * @param data - Raw NAL unit data
 * @returns Data with emulation prevention bytes removed
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
      i += 3; // skip the emulation prevention byte (0x03)
    } else {
      result.push(data[i]);
      i++;
    }
  }
  return new Uint8Array(result);
}

/**
 * Find all NAL units in an H.264 Annex B byte stream.
 *
 * Scans for start codes (0x000001 or 0x00000001) and extracts each
 * NAL unit between consecutive start codes.
 *
 * @param data - Raw Annex B byte stream
 * @returns Array of parsed NAL units
 */
export function findNALUnits(data: Uint8Array): NALUnit[] {
  const units: NALUnit[] = [];
  const startCodePositions: { offset: number; startCodeLength: number }[] = [];

  // Find all start code positions
  for (let i = 0; i < data.length - 2; i++) {
    // Check for 3-byte start code: 0x000001
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      // Check for 4-byte start code: 0x00000001
      const is4Byte = i > 0 && data[i - 1] === 0x00;
      if (is4Byte) {
        startCodePositions.push({ offset: i - 1, startCodeLength: 4 });
      } else {
        startCodePositions.push({ offset: i, startCodeLength: 3 });
      }
      i += 2; // skip past the start code
    }
  }

  // Extract NAL units between start codes
  for (let i = 0; i < startCodePositions.length; i++) {
    const current = startCodePositions[i];
    const naluStart = current.offset + current.startCodeLength;
    const naluEnd =
      i + 1 < startCodePositions.length
        ? startCodePositions[i + 1].offset
        : data.length;

    if (naluStart < naluEnd) {
      const naluData = data.subarray(naluStart, naluEnd);
      const type = naluData[0] & 0x1f;
      units.push({
        type,
        data: naluData,
        offset: current.offset,
      });
    }
  }

  return units;
}

/**
 * Extract the 5-bit NAL unit type from the first byte of a NAL unit.
 *
 * NAL unit header format: forbidden_zero_bit(1) | nal_ref_idc(2) | nal_unit_type(5)
 *
 * @param nalu - NAL unit data (first byte is the NAL header)
 * @returns NAL unit type (0-31)
 */
export function getNALUnitType(nalu: Uint8Array): number {
  if (nalu.length === 0) {
    throw new Error('Empty NAL unit');
  }
  return nalu[0] & 0x1f;
}

/**
 * Parse a Sequence Parameter Set (SPS) NAL unit to extract video parameters.
 *
 * Handles Baseline, Main, High, and other profiles. For High profile and above,
 * parses additional chroma and transform parameters. Correctly handles
 * frame cropping to compute actual video dimensions.
 *
 * @param sps - Raw SPS NAL unit data (starting with NAL header byte)
 * @returns Parsed SPS information including dimensions and codec string
 */
export function parseSPS(sps: Uint8Array): SPSInfo {
  // Remove emulation prevention bytes before parsing
  const rbsp = removeEmulationPreventionBytes(sps);

  // Skip NAL header byte (1 byte)
  const reader = new BitReader(rbsp.subarray(1));

  // profile_idc: u(8)
  const profileIdc = reader.readBits(8);

  // constraint_set0..5_flags + reserved_zero_2bits: u(8)
  const constraintSetFlags = reader.readBits(8);

  // level_idc: u(8)
  const levelIdc = reader.readBits(8);

  // seq_parameter_set_id: ue(v)
  reader.readUE();

  // High profile and above have additional parameters
  let chromaFormatIdc = 1; // default for non-High profiles
  if (
    profileIdc === 100 ||
    profileIdc === 110 ||
    profileIdc === 122 ||
    profileIdc === 244 ||
    profileIdc === 44 ||
    profileIdc === 83 ||
    profileIdc === 86 ||
    profileIdc === 118 ||
    profileIdc === 128 ||
    profileIdc === 138 ||
    profileIdc === 139 ||
    profileIdc === 134 ||
    profileIdc === 135
  ) {
    // chroma_format_idc: ue(v)
    chromaFormatIdc = reader.readUE();

    if (chromaFormatIdc === 3) {
      // separate_colour_plane_flag: u(1)
      reader.readBit();
    }

    // bit_depth_luma_minus8: ue(v)
    reader.readUE();

    // bit_depth_chroma_minus8: ue(v)
    reader.readUE();

    // qpprime_y_zero_transform_bypass_flag: u(1)
    reader.readBit();

    // seq_scaling_matrix_present_flag: u(1)
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

  // log2_max_frame_num_minus4: ue(v)
  reader.readUE();

  // pic_order_cnt_type: ue(v)
  const picOrderCntType = reader.readUE();

  if (picOrderCntType === 0) {
    // log2_max_pic_order_cnt_lsb_minus4: ue(v)
    reader.readUE();
  } else if (picOrderCntType === 1) {
    // delta_pic_order_always_zero_flag: u(1)
    reader.readBit();
    // offset_for_non_ref_pic: se(v)
    reader.readSE();
    // offset_for_top_to_bottom_field: se(v)
    reader.readSE();
    // num_ref_frames_in_pic_order_cnt_cycle: ue(v)
    const numRefFrames = reader.readUE();
    for (let i = 0; i < numRefFrames; i++) {
      // offset_for_ref_frame[i]: se(v)
      reader.readSE();
    }
  }

  // max_num_ref_frames: ue(v)
  reader.readUE();

  // gaps_in_frame_num_value_allowed_flag: u(1)
  reader.readBit();

  // pic_width_in_mbs_minus1: ue(v)
  const picWidthInMbsMinus1 = reader.readUE();

  // pic_height_in_map_units_minus1: ue(v)
  const picHeightInMapUnitsMinus1 = reader.readUE();

  // frame_mbs_only_flag: u(1)
  const frameMbsOnlyFlag = reader.readBit();

  if (!frameMbsOnlyFlag) {
    // mb_adaptive_frame_field_flag: u(1)
    reader.readBit();
  }

  // direct_8x8_inference_flag: u(1)
  reader.readBit();

  // Frame cropping
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;

  // frame_cropping_flag: u(1)
  const frameCroppingFlag = reader.readBit();
  if (frameCroppingFlag) {
    cropLeft = reader.readUE();
    cropRight = reader.readUE();
    cropTop = reader.readUE();
    cropBottom = reader.readUE();
  }

  // Compute dimensions
  // Chroma array type determines the crop unit
  let cropUnitX = 1;
  let cropUnitY = 2 - frameMbsOnlyFlag;

  if (chromaFormatIdc === 1) {
    // 4:2:0
    cropUnitX = 2;
    cropUnitY = 2 * (2 - frameMbsOnlyFlag);
  } else if (chromaFormatIdc === 2) {
    // 4:2:2
    cropUnitX = 2;
    cropUnitY = 2 - frameMbsOnlyFlag;
  }
  // For chromaFormatIdc === 3 (4:4:4) or monochrome (0), use defaults above

  const width =
    (picWidthInMbsMinus1 + 1) * 16 -
    cropUnitX * (cropLeft + cropRight);

  const height =
    (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 -
    cropUnitY * (cropTop + cropBottom);

  const codecString = buildCodecString(sps);

  return {
    profileIdc,
    constraintSetFlags,
    levelIdc,
    width,
    height,
    codecString,
  };
}

/**
 * Build an AVC codec string from an SPS NAL unit.
 *
 * Format: "avc1.XXYYZZ" where:
 * - XX = profile_idc in hex
 * - YY = constraint_set_flags in hex
 * - ZZ = level_idc in hex
 *
 * @param sps - Raw SPS NAL unit data (starting with NAL header byte)
 * @returns Codec string like "avc1.640028"
 */
export function buildCodecString(sps: Uint8Array): string {
  if (sps.length < 4) {
    throw new Error('SPS too short to build codec string');
  }
  // Byte 0: NAL header
  // Byte 1: profile_idc
  // Byte 2: constraint_set_flags
  // Byte 3: level_idc
  const profileIdc = sps[1];
  const constraintFlags = sps[2];
  const levelIdc = sps[3];

  const profileHex = profileIdc.toString(16).padStart(2, '0');
  const constraintHex = constraintFlags.toString(16).padStart(2, '0');
  const levelHex = levelIdc.toString(16).padStart(2, '0');

  return `avc1.${profileHex}${constraintHex}${levelHex}`;
}

/**
 * Check if a NAL unit type represents an IDR (Instantaneous Decoder Refresh) keyframe.
 *
 * @param naluType - NAL unit type value (0-31)
 * @returns true if the NAL unit is an IDR frame (type 5)
 */
export function isKeyframe(naluType: number): boolean {
  return naluType === 5;
}

/**
 * Check if a NAL unit type is a configuration NAL (SPS or PPS).
 *
 * @param naluType - NAL unit type value (0-31)
 * @returns true if the NAL unit is SPS (type 7) or PPS (type 8)
 */
export function isConfigNAL(naluType: number): boolean {
  return naluType === 7 || naluType === 8;
}

/**
 * Check if a NAL unit type is a VCL (Video Coding Layer) type.
 *
 * VCL NAL units (types 1-5) contain actual coded picture data (slices).
 * Non-VCL types (AUD, SEI, etc.) are metadata and should not be sent
 * to clients as standalone video frames.
 *
 * @param naluType - NAL unit type value (0-31)
 * @returns true if the NAL unit contains picture data
 */
export function isVCLNAL(naluType: number): boolean {
  return naluType >= 1 && naluType <= 5;
}

/**
 * Check if a VCL NAL unit is the first slice in a picture.
 *
 * Reads the first_mb_in_slice field, which is the first exp-golomb coded
 * value in the slice header (immediately after the NAL header byte).
 * If first_mb_in_slice is 0, this is the first (or only) slice of the
 * picture, indicating an access unit boundary.
 *
 * The exp-golomb encoding of 0 is a single 1-bit, so we only need to
 * check the MSB of the byte after the NAL header.
 *
 * @param nalu - Raw VCL NAL unit data (starting with NAL header byte)
 * @returns true if first_mb_in_slice is 0 (first/only slice in picture)
 */
export function isFirstSliceInPicture(nalu: Uint8Array): boolean {
  if (nalu.length < 2) return true;
  // first_mb_in_slice is ue(v). The encoding of 0 is a single 1-bit.
  // So if the MSB of byte 1 (first byte of slice header) is 1,
  // first_mb_in_slice == 0, meaning this is the first slice.
  return (nalu[1] & 0x80) !== 0;
}
