/**
 * Global decode scheduler that coordinates frame budget across all streams.
 *
 * The hardware video decoder (Apple VideoToolbox / VAAPI / etc.) has a finite
 * pixel throughput. When many high-resolution streams are active simultaneously,
 * the total decode demand can exceed hardware capacity, causing decode errors
 * and freezes.
 *
 * This scheduler calculates a per-stream target FPS based on:
 * - Total pixel throughput budget (configurable, ~2 billion pixels/sec default)
 * - Each stream's resolution
 * - Number of active streams
 *
 * Streams call `shouldDecode(streamId)` before submitting delta frames.
 * Keyframes are NEVER throttled — they must always be decoded.
 */

import { Logger } from '../utils/logger';

const log = new Logger('DecodeScheduler');

/**
 * Maximum total decode throughput in pixels per second.
 * Apple Silicon M1/M2 media engine can handle roughly 2-3 billion pixels/sec
 * for H.264 decode. We target 2B to leave headroom for OS/browser overhead.
 */
const MAX_PIXELS_PER_SECOND = 2_000_000_000;

/**
 * Minimum target FPS per stream. Below this, the stream looks like a slideshow.
 */
const MIN_TARGET_FPS = 10;

/**
 * Maximum target FPS per stream. Even if budget allows, no need to exceed source fps.
 */
const MAX_TARGET_FPS = 60;

interface StreamInfo {
  width: number;
  height: number;
  sourceFps: number;
  /** Frame counter for current window to enforce target FPS */
  frameCount: number;
  /** Keyframe counter for current window */
  keyframeCount: number;
  /** Start of current 1-second measurement window */
  windowStart: number;
  /** Calculated target FPS for this stream */
  targetFps: number;
  /** Frames skipped in current window */
  skippedFrames: number;
}

export class DecodeScheduler {
  private streams = new Map<number, StreamInfo>();
  private _lastRecalcTime = 0;
  private _totalPixelsPerSec = 0;
  private _budgetUtilization = 0;
  private _budget: number;

  constructor(budget: number = MAX_PIXELS_PER_SECOND) {
    this._budget = budget;
  }

  /** Update the pixel budget (e.g. when splitting across multiple workers) */
  setBudget(budget: number): void {
    this._budget = budget;
    this.recalculateTargets();
  }

  /**
   * Register a stream with its resolution and source FPS.
   * Call this when stream is first configured or reconfigured.
   */
  registerStream(streamId: number, width: number, height: number, sourceFps: number): void {
    const existing = this.streams.get(streamId);
    this.streams.set(streamId, {
      width,
      height,
      sourceFps: sourceFps || 30,
      frameCount: existing?.frameCount ?? 0,
      keyframeCount: existing?.keyframeCount ?? 0,
      windowStart: existing?.windowStart ?? performance.now(),
      targetFps: existing?.targetFps ?? (sourceFps || 30),
      skippedFrames: existing?.skippedFrames ?? 0,
    });
    this.recalculateTargets();
  }

  /** Remove a stream from scheduling */
  unregisterStream(streamId: number): void {
    this.streams.delete(streamId);
    this.recalculateTargets();
  }

  /**
   * Check whether a delta frame should be decoded for this stream.
   * Always returns true for streams that are within their FPS budget.
   * Keyframes should NOT go through this check — always decode them.
   */
  shouldDecodeDelta(streamId: number): boolean {
    const info = this.streams.get(streamId);
    if (!info) return true;

    const now = performance.now();
    const elapsed = now - info.windowStart;

    // Reset window every second
    if (elapsed >= 1000) {
      info.frameCount = 0;
      info.keyframeCount = 0;
      info.skippedFrames = 0;
      info.windowStart = now;
    }

    // Check if we're over the target FPS for this window
    // Account for keyframes already decoded — they count toward total fps
    const totalDecoded = info.frameCount + info.keyframeCount;
    const targetForWindow = Math.ceil(info.targetFps * (Math.min(elapsed, 1000) / 1000));

    if (totalDecoded >= targetForWindow) {
      info.skippedFrames++;
      return false;
    }

    info.frameCount++;
    return true;
  }

  /** Record that a keyframe was decoded (keyframes always pass through) */
  recordKeyframe(streamId: number): void {
    const info = this.streams.get(streamId);
    if (info) {
      info.keyframeCount++;
    }
  }

  /**
   * Recalculate per-stream target FPS based on total pixel budget.
   *
   * Algorithm:
   * 1. Calculate total pixels/sec if all streams run at source FPS
   * 2. If within budget, all streams run at source FPS
   * 3. If over budget, scale down proportionally, with UHD streams
   *    getting reduced first (they benefit least from full FPS in grid view)
   */
  private recalculateTargets(): void {
    const now = performance.now();
    this._lastRecalcTime = now;

    if (this.streams.size === 0) {
      this._totalPixelsPerSec = 0;
      this._budgetUtilization = 0;
      return;
    }

    // Calculate total demand at native FPS
    let totalDemand = 0;
    for (const info of this.streams.values()) {
      totalDemand += info.width * info.height * info.sourceFps;
    }

    this._totalPixelsPerSec = totalDemand;
    this._budgetUtilization = totalDemand / this._budget;

    if (totalDemand <= this._budget) {
      // Within budget — all streams at source FPS
      for (const info of this.streams.values()) {
        info.targetFps = Math.min(info.sourceFps, MAX_TARGET_FPS);
      }
      log.info(`Budget OK: ${(totalDemand / 1e9).toFixed(2)}B px/s (${(this._budgetUtilization * 100).toFixed(0)}% util), ${this.streams.size} streams at native FPS`);
      return;
    }

    // Over budget — need to reduce FPS.
    // Strategy: reduce high-res streams first. Each stream's target is
    // proportional to budget / (pixels_per_frame * num_streams), but
    // we weight by inverse pixel count so smaller streams get more FPS.
    //
    // Simple proportional scaling: each stream's FPS is scaled by
    // (budget / demand) but floored at MIN_TARGET_FPS.

    const scale = this._budget / totalDemand;
    let actualDemand = 0;

    // First pass: scale proportionally, floor at MIN_TARGET_FPS
    for (const info of this.streams.values()) {
      const scaled = Math.round(info.sourceFps * scale);
      info.targetFps = Math.max(MIN_TARGET_FPS, Math.min(scaled, MAX_TARGET_FPS));
      actualDemand += info.width * info.height * info.targetFps;
    }

    // If still over budget after flooring at MIN_TARGET_FPS, there's nothing
    // more we can do — the hardware simply can't keep up. Log a warning.
    if (actualDemand > this._budget * 1.2) {
      log.warn(
        `Decode budget exceeded even at min FPS: ${(actualDemand / 1e9).toFixed(2)}B px/s ` +
        `(budget: ${(this._budget / 1e9).toFixed(1)}B). ` +
        `${this.streams.size} streams, consider reducing source resolution.`
      );
    }

    // Log the targets
    const summary: string[] = [];
    for (const [id, info] of this.streams) {
      summary.push(`s${id}:${info.width}x${info.height}@${info.targetFps}fps(src:${info.sourceFps})`);
    }
    log.info(
      `Budget constrained: ${(totalDemand / 1e9).toFixed(2)}B→${(actualDemand / 1e9).toFixed(2)}B px/s, ` +
      `scale=${scale.toFixed(2)}: ${summary.join(', ')}`
    );
  }

  /** Get the current target FPS for a stream (for metrics/logging) */
  getTargetFps(streamId: number): number {
    return this.streams.get(streamId)?.targetFps ?? 30;
  }

  /** Get scheduler diagnostics for the metrics report */
  get diagnostics(): {
    totalPixelsPerSec: number;
    budgetUtilization: number;
    streamCount: number;
    streamTargets: Array<{ streamId: number; targetFps: number; width: number; height: number; skippedFrames: number }>;
  } {
    const streamTargets = [];
    for (const [id, info] of this.streams) {
      streamTargets.push({
        streamId: id,
        targetFps: info.targetFps,
        width: info.width,
        height: info.height,
        skippedFrames: info.skippedFrames,
      });
    }
    return {
      totalPixelsPerSec: this._totalPixelsPerSec,
      budgetUtilization: this._budgetUtilization,
      streamCount: this.streams.size,
      streamTargets,
    };
  }
}
