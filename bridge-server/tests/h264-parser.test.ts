/**
 * H.264 Parser Tests
 *
 * Tests for NAL unit parsing, SPS extraction, codec string building,
 * and NAL unit type identification.
 */

import { describe, it, expect } from 'vitest';
import {
  findNALUnits,
  getNALUnitType,
  parseSPS,
  buildCodecString,
  isKeyframe,
  isConfigNAL,
} from '../src/h264-parser.js';

describe('findNALUnits', () => {
  it('should find NAL units with 3-byte start codes', () => {
    // Two NAL units separated by 3-byte start codes
    // Start code (00 00 01) + NAL type 7 (SPS) + data
    // Start code (00 00 01) + NAL type 8 (PPS) + data
    const data = new Uint8Array([
      0x00, 0x00, 0x01, 0x67, 0xaa, 0xbb, // SPS
      0x00, 0x00, 0x01, 0x68, 0xcc, 0xdd, // PPS
    ]);

    const units = findNALUnits(data);
    expect(units).toHaveLength(2);

    expect(units[0].type).toBe(7); // SPS
    expect(units[0].data[0]).toBe(0x67);
    expect(units[0].data.length).toBe(3); // 67 aa bb

    expect(units[1].type).toBe(8); // PPS
    expect(units[1].data[0]).toBe(0x68);
    expect(units[1].data.length).toBe(3); // 68 cc dd
  });

  it('should find NAL units with 4-byte start codes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, // SPS
      0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80, // PPS
    ]);

    const units = findNALUnits(data);
    expect(units).toHaveLength(2);

    expect(units[0].type).toBe(7); // SPS
    // With 3-byte detection, the SPS includes a trailing 0x00
    // from the next start code's leading zero
    expect(units[0].data[0]).toBe(0x67);
    expect(units[1].type).toBe(8); // PPS
  });

  it('should handle mixed 3-byte and 4-byte start codes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, // 4-byte start code + SPS
      0x00, 0x00, 0x01, 0x68, 0xce,               // 3-byte start code + PPS
      0x00, 0x00, 0x00, 0x01, 0x65, 0xff, 0xfe,   // 4-byte start code + IDR
    ]);

    const units = findNALUnits(data);
    expect(units).toHaveLength(3);

    expect(units[0].type).toBe(7); // SPS
    expect(units[1].type).toBe(8); // PPS
    expect(units[2].type).toBe(5); // IDR
  });

  it('should return empty array for data with no start codes', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const units = findNALUnits(data);
    expect(units).toHaveLength(0);
  });

  it('should handle a single NAL unit', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x01, 0x65, 0x88, 0x84,
    ]);

    const units = findNALUnits(data);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(5); // IDR
  });

  it('should handle empty input', () => {
    const data = new Uint8Array(0);
    const units = findNALUnits(data);
    expect(units).toHaveLength(0);
  });

  it('should record correct offsets', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, // offset 0 contains 00 00 00 01
      0x00, 0x00, 0x01, 0x68, 0xce,         // offset 6 contains 00 00 01
    ]);

    const units = findNALUnits(data);
    expect(units).toHaveLength(2);
    // With 3-byte detection, the first start code is found at position 1
    // (the 00 00 01 within the 00 00 00 01 pattern)
    expect(units[0].offset).toBe(1);  // 3-byte start code at offset 1
    expect(units[1].offset).toBe(6);  // 3-byte start code at offset 6
  });
});

describe('getNALUnitType', () => {
  it('should extract NAL unit type from header byte', () => {
    // Type 7 (SPS): 0x67 = 0b01100111 -> 0b00111 = 7
    expect(getNALUnitType(new Uint8Array([0x67]))).toBe(7);

    // Type 8 (PPS): 0x68 = 0b01101000 -> 0b01000 = 8
    expect(getNALUnitType(new Uint8Array([0x68]))).toBe(8);

    // Type 5 (IDR): 0x65 = 0b01100101 -> 0b00101 = 5
    expect(getNALUnitType(new Uint8Array([0x65]))).toBe(5);

    // Type 1 (Non-IDR): 0x41 = 0b01000001 -> 0b00001 = 1
    expect(getNALUnitType(new Uint8Array([0x41]))).toBe(1);

    // Type 6 (SEI): 0x06 = 0b00000110 -> 0b00110 = 6
    expect(getNALUnitType(new Uint8Array([0x06]))).toBe(6);

    // Type 9 (AUD): 0x09 = 0b00001001 -> 0b01001 = 9
    expect(getNALUnitType(new Uint8Array([0x09]))).toBe(9);
  });

  it('should throw on empty input', () => {
    expect(() => getNALUnitType(new Uint8Array(0))).toThrow('Empty NAL unit');
  });

  it('should mask correctly with nal_ref_idc bits set', () => {
    // 0x27 = 0b00100111 -> type = 7 (SPS with nal_ref_idc = 01)
    expect(getNALUnitType(new Uint8Array([0x27]))).toBe(7);

    // 0xe5 = 0b11100101 -> type = 5 (IDR with forbidden_zero_bit=1, nal_ref_idc=11)
    expect(getNALUnitType(new Uint8Array([0xe5]))).toBe(5);
  });
});

describe('parseSPS', () => {
  it('should parse a real High Profile 1080p SPS', () => {
    // Real SPS from H.264 High Profile 1080p stream
    // 67 64 00 28 AC D9 40 78 02 27 E5 C0 44 00 00 03 00 04 00 00 03 00 C8 3C 60 C6 58
    const spsBytes = new Uint8Array([
      0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78,
      0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03,
      0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c,
      0x60, 0xc6, 0x58,
    ]);

    const info = parseSPS(spsBytes);

    expect(info.profileIdc).toBe(100); // High Profile
    expect(info.levelIdc).toBe(40);    // Level 4.0
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.codecString).toBe('avc1.640028');
  });

  it('should parse a Baseline Profile 720p SPS', () => {
    // Baseline Profile, Level 3.1, 1280x720
    // NAL header (0x67) + profile_idc=66, constraint_set_flags=0xC0, level=31
    // Minimal SPS for Baseline profile (no High profile extensions)
    //
    // Construct a synthetic Baseline SPS:
    // profile_idc = 66 (0x42), constraints = 0xC0, level = 31 (0x1F)
    // seq_parameter_set_id = 0 (ue: 1)
    // log2_max_frame_num_minus4 = 0 (ue: 1)
    // pic_order_cnt_type = 0 (ue: 1)
    // log2_max_pic_order_cnt_lsb_minus4 = 0 (ue: 1)
    // max_num_ref_frames = 1 (ue: 010)
    // gaps_in_frame_num_value_allowed = 0 (1 bit: 0)
    // pic_width_in_mbs_minus1 = 79 (ue(79)):
    //   codeNum=79, codeNum+1=80, 2^6=64 <= 80 < 128=2^7
    //   leadingZeros=6, suffix=80-64=16=010000
    //   encoding: 0000001 010000 (13 bits)
    // pic_height_in_map_units_minus1 = 44 (ue(44)):
    //   codeNum=44, codeNum+1=45, 2^5=32 <= 45 < 64=2^6
    //   leadingZeros=5, suffix=45-32=13=01101
    //   encoding: 000001 01101 (11 bits)
    // frame_mbs_only_flag = 1
    // direct_8x8_inference_flag = 0
    // frame_cropping_flag = 0
    //
    // Bit layout after the 3 header bytes (profile, constraints, level):
    // pos 0:   1                (seq_parameter_set_id = ue(0))
    // pos 1:   1                (log2_max_frame_num_minus4 = ue(0))
    // pos 2:   1                (pic_order_cnt_type = ue(0))
    // pos 3:   1                (log2_max_pic_order_cnt_lsb_minus4 = ue(0))
    // pos 4-6: 010              (max_num_ref_frames = ue(1))
    // pos 7:   0                (gaps_in_frame_num_value_allowed_flag)
    // --- byte 0: 1111 0100 = 0xF4 ---
    // pos 8-20:  0000001010000  (pic_width_in_mbs_minus1 = ue(79))
    // --- byte 1: 0000 0010 = 0x02 ---
    // --- pos 16-20 continued: 10000 ---
    // pos 21-31: 00000101101    (pic_height_in_map_units_minus1 = ue(44))
    // --- byte 2: 1000 0000 = 0x80 ---
    // --- byte 3: 0101 1011 = wait ---
    // pos 16: 1 (from width suffix)
    // pos 17: 0
    // pos 18: 0
    // pos 19: 0
    // pos 20: 0 (end of width)
    // pos 21: 0 (height leading zeros)
    // pos 22: 0
    // pos 23: 0
    // --- byte 2: 1000 0000 = 0x80 ---
    // pos 24: 0
    // pos 25: 0
    // pos 26: 1 (height '1' bit)
    // pos 27: 0 (suffix bit)
    // pos 28: 1
    // pos 29: 1
    // pos 30: 0
    // pos 31: 1
    // --- byte 3: 0010 1101 = 0x2D ---
    // pos 32: 1 (frame_mbs_only_flag)
    // pos 33: 0 (direct_8x8_inference_flag)
    // pos 34: 0 (frame_cropping_flag)
    // pos 35-39: 00000 (padding)
    // --- byte 4: 1000 0000 = 0x80 ---
    const spsBytes = new Uint8Array([
      0x67,       // NAL header: type 7 (SPS), nal_ref_idc = 3
      0x42,       // profile_idc = 66 (Baseline)
      0xc0,       // constraint_set0_flag=1, constraint_set1_flag=1, rest=0
      0x1f,       // level_idc = 31
      0xf4, 0x02, 0x80, 0x2d, 0x80,
    ]);

    const info = parseSPS(spsBytes);

    expect(info.profileIdc).toBe(66);     // Baseline
    expect(info.levelIdc).toBe(31);       // Level 3.1
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(info.codecString).toBe('avc1.42c01f');
  });

  it('should return correct constraint set flags', () => {
    const spsBytes = new Uint8Array([
      0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78,
      0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03,
      0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xc8, 0x3c,
      0x60, 0xc6, 0x58,
    ]);

    const info = parseSPS(spsBytes);
    expect(info.constraintSetFlags).toBe(0x00);
  });
});

describe('buildCodecString', () => {
  it('should build codec string from SPS bytes', () => {
    // High Profile (0x64), no constraints (0x00), Level 4.0 (0x28)
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0x00]);
    expect(buildCodecString(sps)).toBe('avc1.640028');
  });

  it('should build codec string for Baseline Profile', () => {
    // Baseline (0x42), constraints (0xC0), Level 3.1 (0x1F)
    const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0x00]);
    expect(buildCodecString(sps)).toBe('avc1.42c01f');
  });

  it('should build codec string for Main Profile', () => {
    // Main (0x4D), constraints (0x40), Level 3.0 (0x1E)
    const sps = new Uint8Array([0x67, 0x4d, 0x40, 0x1e, 0x00]);
    expect(buildCodecString(sps)).toBe('avc1.4d401e');
  });

  it('should pad single-digit hex values with leading zero', () => {
    // Profile 0x0A, constraints 0x00, level 0x09
    const sps = new Uint8Array([0x67, 0x0a, 0x00, 0x09, 0x00]);
    expect(buildCodecString(sps)).toBe('avc1.0a0009');
  });

  it('should throw for SPS shorter than 4 bytes', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00]);
    expect(() => buildCodecString(sps)).toThrow('SPS too short');
  });
});

describe('isKeyframe', () => {
  it('should return true for IDR type (5)', () => {
    expect(isKeyframe(5)).toBe(true);
  });

  it('should return false for non-IDR slice type (1)', () => {
    expect(isKeyframe(1)).toBe(false);
  });

  it('should return false for SPS type (7)', () => {
    expect(isKeyframe(7)).toBe(false);
  });

  it('should return false for PPS type (8)', () => {
    expect(isKeyframe(8)).toBe(false);
  });

  it('should return false for type 0', () => {
    expect(isKeyframe(0)).toBe(false);
  });
});

describe('isConfigNAL', () => {
  it('should return true for SPS type (7)', () => {
    expect(isConfigNAL(7)).toBe(true);
  });

  it('should return true for PPS type (8)', () => {
    expect(isConfigNAL(8)).toBe(true);
  });

  it('should return false for IDR type (5)', () => {
    expect(isConfigNAL(5)).toBe(false);
  });

  it('should return false for non-IDR slice type (1)', () => {
    expect(isConfigNAL(1)).toBe(false);
  });

  it('should return false for SEI type (6)', () => {
    expect(isConfigNAL(6)).toBe(false);
  });

  it('should return false for AUD type (9)', () => {
    expect(isConfigNAL(9)).toBe(false);
  });
});

describe('findNALUnits integration', () => {
  it('should correctly parse a realistic H.264 access unit', () => {
    // Simulate a typical access unit: AUD + SPS + PPS + IDR
    const aud = new Uint8Array([0x09, 0xf0]);                         // AUD
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac]);      // SPS fragment
    const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);             // PPS
    const idr = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0xff, 0xfe]); // IDR fragment

    const startCode4 = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    const startCode3 = new Uint8Array([0x00, 0x00, 0x01]);

    // Build complete access unit
    const accessUnit = new Uint8Array([
      ...startCode4, ...aud,
      ...startCode4, ...sps,
      ...startCode3, ...pps,
      ...startCode4, ...idr,
    ]);

    const units = findNALUnits(accessUnit);
    expect(units).toHaveLength(4);

    expect(units[0].type).toBe(9);  // AUD
    expect(units[1].type).toBe(7);  // SPS
    expect(units[2].type).toBe(8);  // PPS
    expect(units[3].type).toBe(5);  // IDR

    // Verify SPS data
    expect(units[1].data[0]).toBe(0x67);
    expect(units[1].data[1]).toBe(0x64); // profile_idc

    // Verify the IDR data includes all bytes
    expect(units[3].data).toEqual(idr);
  });
});
