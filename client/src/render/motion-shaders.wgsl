// ═══════════════════════════════════════════════════════════════
// GPU Motion Detection — 2 compute passes
//
// Pass 1: motion_frame_diff   — Per-pixel absolute difference (current vs previous)
// Pass 2: motion_zone_reduce  — Count motion pixels within each alert zone
//
// Frame differencing with adaptive thresholding. Motion scores
// are written to a small storage buffer for CPU readback at 1Hz.
// ═══════════════════════════════════════════════════════════════

struct MotionUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  threshold: f32,         // per-pixel luma diff threshold (0..1)
  padding1: f32,
  padding2: f32,
  padding3: f32,
};

// Zone definition: normalized [0,1] rectangle + index
struct AlertZone {
  x: f32,    // top-left U
  y: f32,    // top-left V
  w: f32,    // width in UV
  h: f32,    // height in UV
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: MotionUniforms;

fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0), 0.0) + vec4(params.threshold);
}

fn motionLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// ═══════════════════════════════════════════════════════════════
// PASS 1: Frame Differencing
// ═══════════════════════════════════════════════════════════════
//
// Compares current frame to previous frame. Writes a motion mask
// texture: 1.0 where motion exceeds threshold, 0.0 otherwise.
//
// Bindings (group 1):
//   binding 0: prevMotionFrame (texture_2d<f32>) — previous frame
//   binding 1: motionMask (texture_storage_2d<r32float, write>) — output motion mask
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var prevMotionFrame: texture_2d<f32>;
@group(1) @binding(1) var motionMask: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn motion_frame_diff(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);

  let curColor = textureLoad(srcTexture, coord, 0).rgb;
  let prevColor = textureLoad(prevMotionFrame, coord, 0).rgb;

  let curLuma = motionLuma(curColor);
  let prevLuma = motionLuma(prevColor);

  let diff = abs(curLuma - prevLuma);

  // Also check color channel differences for sensitivity
  let colorDiff = length(curColor - prevColor);
  let combinedDiff = max(diff, colorDiff * 0.5);

  let motion = select(0.0, combinedDiff, combinedDiff > params.threshold);

  textureStore(motionMask, coord, vec4<f32>(motion, 0.0, 0.0, 0.0));
}

// ═══════════════════════════════════════════════════════════════
// PASS 2: Zone Reduction
// ═══════════════════════════════════════════════════════════════
//
// For each alert zone, count the number of motion pixels and
// compute the average motion score. Uses atomicAdd on a storage
// buffer for parallel reduction.
//
// Bindings (group 2):
//   binding 0: motionMaskRead (texture_2d<f32>) — motion mask from pass 1
//   binding 1: zoneData (storage, read) — array of AlertZone structs
//   binding 2: zoneResults (storage, read_write) — atomic counters per zone
//   binding 3: zoneUniforms (uniform) — zone count
//
// Each workgroup processes a tile of pixels and atomically
// accumulates motion pixel count per zone.
// ═══════════════════════════════════════════════════════════════

struct ZoneReduceUniforms {
  dimensions: vec2<f32>,  // width, height
  zoneCount: u32,
  padding: u32,
};

// Per-zone result: [motionPixelCount, totalPixelCount] as atomics
// Stored as flat array: zone[i] = results[i*2], results[i*2+1]

@group(2) @binding(0) var motionMaskRead: texture_2d<f32>;
@group(2) @binding(1) var<storage, read> zones: array<AlertZone>;
@group(2) @binding(2) var<storage, read_write> zoneResults: array<atomic<u32>>;
@group(2) @binding(3) var<uniform> zoneParams: ZoneReduceUniforms;

@compute @workgroup_size(8, 8)
fn motion_zone_reduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = vec2<u32>(zoneParams.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let uv = vec2<f32>(f32(gid.x) / f32(dims.x), f32(gid.y) / f32(dims.y));

  let motion = textureLoad(motionMaskRead, coord, 0).r;

  // Check each zone
  for (var i: u32 = 0u; i < zoneParams.zoneCount; i++) {
    let zone = zones[i];
    // Check if pixel is inside zone
    if (uv.x >= zone.x && uv.x < zone.x + zone.w &&
        uv.y >= zone.y && uv.y < zone.y + zone.h) {
      // Increment total pixel count for this zone
      atomicAdd(&zoneResults[i * 2u + 1u], 1u);
      // If motion detected, increment motion pixel count
      if (motion > 0.0) {
        atomicAdd(&zoneResults[i * 2u], 1u);
      }
    }
  }
}
