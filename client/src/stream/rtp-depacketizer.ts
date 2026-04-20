/**
 * H.264 RTP Depacketizer (RFC 6184)
 *
 * Receives raw RTP packets and reassembles them into complete H.264 NAL
 * units and access units suitable for WebCodecs VideoDecoder.
 *
 * Handles three RTP payload types for H.264:
 * - **Single NAL Unit** (types 1-23): One NAL unit per RTP packet
 * - **STAP-A** (type 24): Multiple NAL units aggregated in one packet
 * - **FU-A** (type 28): Large NAL unit fragmented across multiple packets
 *
 * Uses the RTP marker bit to detect access unit boundaries. When the
 * marker bit is set, the current access unit is complete and can be
 * submitted for decoding.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6184 — RTP Payload Format for H.264
 */

import { Logger } from '../utils/logger';

/** A reassembled NAL unit from RTP depacketization */
export interface DepacketizedNAL {
  /** NAL unit type (lower 5 bits of NAL header) */
  type: number;
  /** Raw NAL unit data (including NAL header byte, no start code) */
  data: Uint8Array;
}

/** A complete access unit ready for decoding */
export interface AccessUnit {
  /** NAL units in this access unit */
  nalUnits: DepacketizedNAL[];
  /** RTP timestamp (90kHz clock) */
  timestamp: number;
  /** Whether this AU contains an IDR keyframe */
  isKeyframe: boolean;
}

/** Callback invoked when a complete access unit is assembled */
export type AccessUnitCallback = (au: AccessUnit) => void;

/**
 * H.264 RTP Depacketizer per RFC 6184.
 *
 * Stateful: tracks FU-A fragmentation and access unit accumulation
 * across consecutive RTP packets. Packets must be fed in sequence
 * number order (reordering is not handled).
 */
export class RTPDepacketizer {
  /** Accumulated NAL units for the current access unit */
  private currentAU: DepacketizedNAL[] = [];
  /** RTP timestamp of the current access unit */
  private currentTimestamp: number = -1;
  /** Whether the current AU contains a keyframe */
  private currentIsKeyframe = false;
  /** Expected next sequence number for loss detection */
  private expectedSeq: number = -1;
  /** FU-A reassembly buffer */
  private fuBuffer: Uint8Array[] = [];
  /** FU-A NAL header (NRI + type from FU indicator + FU header) */
  private fuNALHeader: number = 0;
  /** Whether we're in the middle of a FU-A reassembly */
  private fuInProgress = false;

  private readonly log: Logger;

  /** Callback invoked when a complete access unit is ready */
  onAccessUnit: AccessUnitCallback | null = null;

  constructor() {
    this.log = new Logger('RTPDepacketizer');
  }

  /**
   * Process a raw RTP packet.
   *
   * Parses the RTP header, extracts the H.264 payload, depacketizes
   * NAL units, and emits complete access units via the callback.
   *
   * @param packet - Raw RTP packet bytes (including RTP header)
   */
  processPacket(packet: Uint8Array): void {
    if (packet.length < 12) {
      this.log.warn(`RTP packet too short: ${packet.length}`);
      return;
    }

    // Parse RTP header
    const version = (packet[0] >> 6) & 0x03;
    if (version !== 2) {
      this.log.warn(`Invalid RTP version: ${version}`);
      return;
    }

    const padding = (packet[0] & 0x20) !== 0;
    const hasExtension = (packet[0] & 0x10) !== 0;
    const csrcCount = packet[0] & 0x0f;
    const marker = (packet[1] & 0x80) !== 0;
    const sequenceNumber = (packet[2] << 8) | packet[3];
    const timestamp =
      ((packet[4] << 24) | (packet[5] << 16) | (packet[6] << 8) | packet[7]) >>> 0;

    // Calculate payload offset (past fixed header + CSRC entries)
    let payloadOffset = 12 + csrcCount * 4;

    // Skip header extension if present
    if (hasExtension && payloadOffset + 4 <= packet.length) {
      const extLength = (packet[payloadOffset + 2] << 8) | packet[payloadOffset + 3];
      payloadOffset += 4 + extLength * 4;
    }

    // Remove padding bytes if present
    let payloadEnd = packet.length;
    if (padding && packet.length > 0) {
      const paddingLength = packet[packet.length - 1];
      payloadEnd -= paddingLength;
    }

    if (payloadOffset >= payloadEnd) {
      return; // No payload
    }

    const payload = packet.subarray(payloadOffset, payloadEnd);

    // Sequence number gap detection
    if (this.expectedSeq >= 0 && sequenceNumber !== this.expectedSeq) {
      const gap = (sequenceNumber - this.expectedSeq + 65536) % 65536;
      if (gap > 0 && gap < 1000) {
        this.log.warn(`Sequence gap: expected ${this.expectedSeq}, got ${sequenceNumber} (${gap} lost)`);
        // Abort any in-progress FU-A reassembly
        if (this.fuInProgress) {
          this.fuBuffer = [];
          this.fuInProgress = false;
        }
      }
    }
    this.expectedSeq = (sequenceNumber + 1) & 0xffff;

    // If timestamp changed, flush the previous access unit
    if (this.currentTimestamp >= 0 && timestamp !== this.currentTimestamp) {
      this.flushAccessUnit();
    }
    this.currentTimestamp = timestamp;

    // Depacketize H.264 payload
    this.depacketize(payload);

    // RTP marker bit indicates end of access unit
    if (marker) {
      this.flushAccessUnit();
    }
  }

  /**
   * Depacketize an H.264 RTP payload.
   *
   * Determines the packet type from the first byte and dispatches to
   * the appropriate handler.
   */
  private depacketize(payload: Uint8Array): void {
    if (payload.length === 0) return;

    const nalType = payload[0] & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      // Single NAL Unit Packet — the entire payload is one NAL unit
      this.addNAL(nalType, payload);
    } else if (nalType === 24) {
      // STAP-A (Single-Time Aggregation Packet)
      this.handleSTAPA(payload);
    } else if (nalType === 28) {
      // FU-A (Fragmentation Unit)
      this.handleFUA(payload);
    } else {
      // STAP-B (25), MTAP16 (26), MTAP24 (27), FU-B (29) — rare, skip
      this.log.warn(`Unsupported RTP NAL type: ${nalType}`);
    }
  }

  /**
   * Handle a STAP-A (Single-Time Aggregation Packet, type 24).
   *
   * Contains multiple NAL units, each preceded by a 2-byte length.
   * All NAL units share the same RTP timestamp.
   *
   * Format:
   * ```
   * +------+--------+------+--------+------+--------+---
   * | STAP | Size 1 | NAL1 | Size 2 | NAL2 | Size 3 | ...
   * | hdr  | 2 bytes|      | 2 bytes|      | 2 bytes|
   * +------+--------+------+--------+------+--------+---
   * ```
   */
  private handleSTAPA(payload: Uint8Array): void {
    let offset = 1; // Skip STAP-A header byte

    while (offset + 2 <= payload.length) {
      const nalSize = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;

      if (offset + nalSize > payload.length) {
        this.log.warn(`STAP-A NAL unit exceeds packet boundary`);
        break;
      }

      const nalData = payload.subarray(offset, offset + nalSize);
      const nalType = nalData[0] & 0x1f;
      // Make a copy since we store the data
      this.addNAL(nalType, new Uint8Array(nalData));
      offset += nalSize;
    }
  }

  /**
   * Handle a FU-A (Fragmentation Unit, type 28).
   *
   * A large NAL unit is split across multiple RTP packets. The FU-A
   * header contains start/end bits indicating fragment position.
   *
   * Format:
   * ```
   * +------+------+------+------+------+
   * | FU   | FU   | FU payload         |
   * | ind. | hdr  | (NAL fragment)     |
   * | 1 b  | 1 b  |                    |
   * +------+------+------+------+------+
   *
   * FU indicator: F(1) NRI(2) Type(5)=28
   * FU header:    S(1) E(1) R(1) Type(5)
   * ```
   */
  private handleFUA(payload: Uint8Array): void {
    if (payload.length < 2) return;

    const fuIndicator = payload[0];
    const fuHeader = payload[1];
    const startBit = (fuHeader & 0x80) !== 0;
    const endBit = (fuHeader & 0x40) !== 0;
    const nalType = fuHeader & 0x1f;

    if (startBit) {
      // First fragment — reconstruct the NAL header byte
      // NRI comes from the FU indicator, type from the FU header
      this.fuNALHeader = (fuIndicator & 0xe0) | nalType;
      this.fuBuffer = [payload.subarray(2)];
      this.fuInProgress = true;
    } else if (this.fuInProgress) {
      // Middle or last fragment
      this.fuBuffer.push(payload.subarray(2));

      if (endBit) {
        // Last fragment — reassemble the complete NAL unit
        const totalSize = 1 + this.fuBuffer.reduce((sum, b) => sum + b.length, 0);
        const nalData = new Uint8Array(totalSize);
        nalData[0] = this.fuNALHeader;

        let offset = 1;
        for (const fragment of this.fuBuffer) {
          nalData.set(fragment, offset);
          offset += fragment.length;
        }

        this.addNAL(nalType, nalData);
        this.fuBuffer = [];
        this.fuInProgress = false;
      }
    }
    // If we get a non-start fragment without fuInProgress, drop it (lost start)
  }

  /**
   * Add a depacketized NAL unit to the current access unit.
   */
  private addNAL(type: number, data: Uint8Array): void {
    this.currentAU.push({ type, data });
    if (type === 5) {
      this.currentIsKeyframe = true;
    }
  }

  /**
   * Flush the current access unit and invoke the callback.
   */
  private flushAccessUnit(): void {
    if (this.currentAU.length === 0) return;

    if (this.onAccessUnit) {
      this.onAccessUnit({
        nalUnits: this.currentAU,
        timestamp: this.currentTimestamp,
        isKeyframe: this.currentIsKeyframe,
      });
    }

    this.currentAU = [];
    this.currentIsKeyframe = false;
  }

  /**
   * Reset the depacketizer state.
   * Call this on stream discontinuities or reconnections.
   */
  reset(): void {
    this.currentAU = [];
    this.currentTimestamp = -1;
    this.currentIsKeyframe = false;
    this.expectedSeq = -1;
    this.fuBuffer = [];
    this.fuInProgress = false;
  }
}
