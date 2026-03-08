/**
 * Device detection utility for adaptive mobile/desktop behavior.
 *
 * Detects device capabilities and returns recommended settings
 * for stream count, GPU power preference, and DPR cap.
 */

/** Device profile with recommended settings */
export interface DeviceProfile {
  /** True if device has coarse pointer (touch) and narrow screen */
  isMobile: boolean;
  /** Maximum recommended concurrent streams */
  maxStreams: number;
  /** GPU adapter power preference */
  gpuPowerPreference: GPUPowerPreference;
  /** Maximum device pixel ratio to use (caps GPU fill rate) */
  maxDPR: number;
}

/**
 * Detect device capabilities and return an adaptive profile.
 *
 * Uses `pointer: coarse` media query (touch screen) combined with
 * narrow viewport width to classify mobile devices. This is more
 * reliable than user-agent sniffing.
 */
export function detectDevice(): DeviceProfile {
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const isNarrowScreen = window.innerWidth <= 768;
  const isMobile = isCoarsePointer && isNarrowScreen;

  return {
    isMobile,
    maxStreams: isMobile ? 4 : 16,
    gpuPowerPreference: isMobile ? 'low-power' : 'high-performance',
    maxDPR: isMobile ? 2.0 : window.devicePixelRatio || 1,
  };
}

/** Heavy upscale modes that should be disabled on mobile */
const HEAVY_UPSCALE_MODES = new Set(['a4k', 'tsr', 'spec', 'vqsr', 'gen', 'dlss']);

/** Lightweight upscale modes safe for mobile */
const LIGHT_UPSCALE_MODES = new Set(['off', 'cas', 'fsr']);

/**
 * Check if an upscale mode is suitable for the current device.
 * On mobile, only lightweight modes (off, CAS, FSR) are allowed.
 */
export function isUpscaleModeAllowed(mode: string, isMobile: boolean): boolean {
  if (!isMobile) return true;
  return LIGHT_UPSCALE_MODES.has(mode);
}

/**
 * Get the list of heavy upscale mode values (for disabling UI options).
 */
export function getHeavyUpscaleModes(): ReadonlySet<string> {
  return HEAVY_UPSCALE_MODES;
}
