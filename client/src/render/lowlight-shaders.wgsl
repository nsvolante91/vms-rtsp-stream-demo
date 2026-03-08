// ═══════════════════════════════════════════════════════════════
// Low-Light Enhancement — 3 compute passes
//
// Pass 1: lowlight_luminance   — Compute per-pixel luminance + global avg
// Pass 2: lowlight_denoise     — Temporal denoise (weighted blend with history)
// Pass 3: lowlight_enhance     — Adaptive gamma + local contrast + sharpen
//
// Brightens dark scenes while suppressing noise via temporal
// averaging. Adaptive gamma curve shifts based on average scene
// luminance so bright scenes aren't over-brightened.
// ═══════════════════════════════════════════════════════════════

struct LowLightUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  frameCount: f32,        // frames accumulated since mode enabled
  strength: f32,          // enhancement strength 0..1
  denoiseWeight: f32,     // temporal denoise blend (0=current only, 1=history only)
  padding: f32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: LowLightUniforms;

fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0), 0.0) + vec4(params.strength);
}

fn llLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// ═══════════════════════════════════════════════════════════════
// PASS 1: Luminance Analysis
// ═══════════════════════════════════════════════════════════════
//
// Computes per-pixel luminance and accumulates into an atomic
// sum for global average luminance calculation. Writes luminance
// to a texture for pass 3.
//
// Bindings (group 1):
//   binding 0: lumaTex (texture_storage_2d<r32float, write>)
//   binding 1: lumaStats (storage, read_write) — atomic sum + count
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var lumaTex: texture_storage_2d<r32float, write>;
@group(1) @binding(1) var<storage, read_write> lumaStats: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn lowlight_luminance(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let color = textureLoad(srcTexture, coord, 0).rgb;
  let luma = llLuma(color);

  textureStore(lumaTex, coord, vec4<f32>(luma, 0.0, 0.0, 0.0));

  // Accumulate luma (quantized to integer) for global average
  // Multiply by 1000 to preserve fractional precision in atomic u32
  atomicAdd(&lumaStats[0], u32(luma * 1000.0));
  atomicAdd(&lumaStats[1], 1u);
}

// ═══════════════════════════════════════════════════════════════
// PASS 2: Temporal Denoise
// ═══════════════════════════════════════════════════════════════
//
// Blends current frame with history using edge-aware weighting.
// Areas with large frame-to-frame differences (motion) use more
// of the current frame to avoid ghosting.
//
// Bindings (group 1):
//   binding 0: historyTex (texture_2d<f32>) — previous denoised frame
//   binding 1: denoisedOut (texture_storage_2d<rgba8unorm, write>)
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var historyTex: texture_2d<f32>;
@group(1) @binding(1) var denoisedOut: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn lowlight_denoise(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let current = textureLoad(srcTexture, coord, 0).rgb;
  let history = textureLoad(historyTex, coord, 0).rgb;

  // Motion-adaptive blend weight
  let diff = length(current - history);
  // Higher diff = more current frame (avoid ghosting on motion)
  let motionFactor = smoothstep(0.02, 0.15, diff);
  // Base temporal weight from uniforms, reduced when motion detected
  let weight = mix(params.denoiseWeight, 0.1, motionFactor);

  // On first frame, use current frame only
  var result: vec3<f32>;
  if (params.frameCount < 1.5) {
    result = current;
  } else {
    result = mix(current, history, weight);
  }

  textureStore(denoisedOut, coord, vec4<f32>(result, 1.0));
}

// ═══════════════════════════════════════════════════════════════
// PASS 3: Adaptive Enhancement
// ═══════════════════════════════════════════════════════════════
//
// Applies adaptive gamma correction based on scene luminance,
// local contrast enhancement, and unsharp mask sharpening.
//
// Bindings (group 1):
//   binding 0: denoisedTex (texture_2d<f32>) — denoised input
//   binding 1: lumaTex (texture_2d<f32>) — per-pixel luminance
//   binding 2: lumaStatsRead (storage, read) — global average luma
//   binding 3: outputTex (texture_storage_2d<rgba8unorm, write>)
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var denoisedTex: texture_2d<f32>;
@group(1) @binding(1) var lumaTexRead: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> lumaStatsRead: array<u32>;
@group(1) @binding(3) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn lowlight_enhance(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let color = textureLoad(denoisedTex, coord, 0).rgb;
  let localLuma = textureLoad(lumaTexRead, coord, 0).r;

  // Compute global average luminance
  let lumaSum = f32(lumaStatsRead[0]) / 1000.0;
  let lumaCount = f32(max(lumaStatsRead[1], 1u));
  let avgLuma = lumaSum / lumaCount;

  // Adaptive gamma: darker scenes get lower gamma (more brightening)
  // Range: gamma 0.3 (very dark) to 1.0 (well-lit)
  let targetBrightness = 0.4;
  let gamma = clamp(mix(0.35, 1.0, avgLuma / targetBrightness), 0.3, 1.2);

  // Apply gamma correction
  var enhanced = pow(max(color, vec3(0.001)), vec3(gamma));

  // Local contrast enhancement (mild)
  // Sample neighborhood luminance
  var neighborLuma: f32 = 0.0;
  for (var dy: i32 = -1; dy <= 1; dy++) {
    for (var dx: i32 = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let nc = clamp(coord + vec2<i32>(dx, dy), vec2(0), vec2<i32>(dims) - 1);
      neighborLuma += textureLoad(lumaTexRead, nc, 0).r;
    }
  }
  neighborLuma /= 8.0;

  // Boost local contrast
  let localContrast = (localLuma - neighborLuma) * params.strength * 0.5;
  enhanced += vec3(localContrast);

  // Unsharp mask sharpening (very light)
  let center = textureLoad(denoisedTex, coord, 0).rgb;
  var blur: vec3<f32> = vec3(0.0);
  for (var dy2: i32 = -1; dy2 <= 1; dy2++) {
    for (var dx2: i32 = -1; dx2 <= 1; dx2++) {
      let nc = clamp(coord + vec2<i32>(dx2, dy2), vec2(0), vec2<i32>(dims) - 1);
      blur += textureLoad(denoisedTex, nc, 0).rgb;
    }
  }
  blur /= 9.0;
  let sharpDetail = (center - blur) * params.strength * 0.3;
  enhanced += sharpDetail;

  // Clamp and write
  textureStore(outputTex, coord, vec4<f32>(clamp(enhanced, vec3(0.0), vec3(1.0)), 1.0));
}
