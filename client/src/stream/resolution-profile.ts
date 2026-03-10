/**
 * Resolution- and fps-adaptive profile for tuning pipeline parameters.
 *
 * Defines three resolution tiers (SD, HD, UHD) based on pixel count,
 * then scales decode queue thresholds by the frame rate. Higher fps
 * means frames arrive faster, so the decoder needs proportionally
 * more queue headroom before dropping.
 *
 * Base thresholds are calibrated for 30 fps. At 60 fps the multiplier
 * doubles them; at 24 fps it slightly reduces them (never below 1).
 */

export type ResolutionTier = 'sd' | 'hd' | 'uhd';

export interface ResolutionProfile {
  tier: ResolutionTier;
  /** Decoder queue: accept all frames below this level */
  normalThreshold: number;
  /** Decoder queue: start dropping likely B-frames */
  softThreshold: number;
  /** Decoder queue: drop all non-keyframes */
  hardThreshold: number;
  /** Max jitter correction per frame (microseconds) */
  maxJitterCorrectionUs: number;
  /** Hardware acceleration hint for VideoDecoderConfig */
  hardwareAcceleration: HardwareAcceleration;
  /** Source fps (0 = unknown) — passed through for downstream use */
  fps: number;
}

/** Base thresholds per resolution tier (calibrated for 30 fps) */
const BASE_PROFILES = {
  uhd: { normalThreshold: 4, softThreshold: 6, hardThreshold: 10, maxJitterCorrectionUs: 25_000, hardwareAcceleration: 'prefer-hardware' as HardwareAcceleration },
  hd:  { normalThreshold: 3, softThreshold: 5, hardThreshold: 8,  maxJitterCorrectionUs: 20_000, hardwareAcceleration: 'no-preference' as HardwareAcceleration },
  sd:  { normalThreshold: 2, softThreshold: 3, hardThreshold: 5,  maxJitterCorrectionUs: 10_000, hardwareAcceleration: 'no-preference' as HardwareAcceleration },
} as const;

/**
 * Determine the optimization profile from stream dimensions and fps.
 *
 * Tiers (by pixel count):
 * - **SD** (≤ 921,600 px = 1280×720): Low decode cost, tight thresholds.
 * - **HD** (≤ 2,073,600 px = 1920×1080): Moderate decode cost.
 * - **UHD** (> 2,073,600 px, e.g., 4K): High decode cost, hardware essential.
 *
 * Thresholds scale linearly with fps/30 so that:
 *   - 24 fps → ×0.8  (slightly tighter)
 *   - 30 fps → ×1.0  (baseline)
 *   - 60 fps → ×2.0  (double headroom)
 *
 * @param fps - Source framerate (0 or omitted = assume 30 fps)
 */
export function getResolutionProfile(width: number, height: number, fps = 0): ResolutionProfile {
  const pixels = width * height;

  let tier: ResolutionTier;
  if (pixels > 2_073_600) {
    tier = 'uhd';
  } else if (pixels >= 921_600) {
    tier = 'hd';
  } else {
    tier = 'sd';
  }

  const base = BASE_PROFILES[tier];
  // Scale by fps relative to 30 fps baseline; clamp minimum at 0.8
  const effectiveFps = fps > 0 ? fps : 30;
  const scale = Math.max(0.8, effectiveFps / 30);

  return {
    tier,
    normalThreshold: Math.max(1, Math.round(base.normalThreshold * scale)),
    softThreshold:   Math.max(2, Math.round(base.softThreshold * scale)),
    hardThreshold:   Math.max(3, Math.round(base.hardThreshold * scale)),
    maxJitterCorrectionUs: base.maxJitterCorrectionUs,
    hardwareAcceleration: base.hardwareAcceleration,
    fps: effectiveFps,
  };
}
