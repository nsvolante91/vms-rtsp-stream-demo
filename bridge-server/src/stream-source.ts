/**
 * Stream Source Interface
 *
 * Common interface for all video stream sources (RTSP, local file, etc.).
 * Both RTSPClient and LocalStreamSource implement this interface so the
 * StreamManager can treat them uniformly.
 */

import type { EventEmitter } from 'events';
import type { SPSInfo } from './h264-parser.js';

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

/**
 * A source of H.264 NAL units. Emits parsed NAL units as events.
 *
 * Events:
 * - `nalu` — a complete NAL unit was extracted
 * - `sps`  — an SPS NAL unit was parsed (includes resolution, codec string)
 * - `error` — a non-fatal error occurred
 * - `close` — the source has stopped producing data
 */
export interface StreamSource extends EventEmitter {
  /** Begin producing H.264 data. */
  connect(): Promise<void>;

  /** Stop producing data and release resources. */
  close(): void;

  /** Hint that no subscribers are listening (may be a no-op). */
  pause(): void;

  /** Hint that subscribers are listening again (may be a no-op). */
  resume(): void;

  /** Whether the source is currently producing data. */
  isRunning(): boolean;

  /** Parsed SPS info, or null if not yet received. */
  getSPSInfo(): SPSInfo | null;

  // EventEmitter methods are inherited
  on(event: 'nalu', listener: (evt: NALUEvent) => void): this;
  on(event: 'sps', listener: (info: SPSInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  emit(event: 'nalu', evt: NALUEvent): boolean;
  emit(event: 'sps', info: SPSInfo): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'close'): boolean;
}
