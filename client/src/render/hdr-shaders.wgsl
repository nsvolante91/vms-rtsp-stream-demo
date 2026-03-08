// ═══════════════════════════════════════════════════════════════
// HDR Tone Mapping — 2 compute passes
//
// Pass 1: hdr_histogram    — Build luminance histogram using atomics
// Pass 2: hdr_tonemap      — ACES tone mapping with auto-exposure
//
// Auto-exposure uses histogram-based average luminance to set
// the exposure level. ACES filmic curve preserves highlights
// better than simple gamma. Color grading adds warmth.
// ═══════════════════════════════════════════════════════════════

struct HDRUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  exposure: f32,          // exposure adjustment (default 1.0)
  saturation: f32,        // color saturation boost (default 1.0)
  contrast: f32,          // contrast adjustment (default 1.0)
  padding: f32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: HDRUniforms;

fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0), 0.0) + vec4(params.exposure);
}

fn hdrLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// ═══════════════════════════════════════════════════════════════
// PASS 1: Histogram Computation
// ═══════════════════════════════════════════════════════════════
//
// Builds a 256-bin luminance histogram using atomicAdd on a
// storage buffer. Also accumulates total luminance for average.
//
// Bindings (group 1):
//   binding 0: histogram (storage, read_write) — 256 atomic u32 bins + 2 for sum/count
// ═══════════════════════════════════════════════════════════════

// histogram[0..255] = bin counts
// histogram[256] = total luma * 1000 (accumulator)
// histogram[257] = pixel count

@group(1) @binding(0) var<storage, read_write> histogram: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn hdr_histogram(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let color = textureLoad(srcTexture, coord, 0).rgb;
  let luma = hdrLuma(color);

  // Bin index: 0..255
  let bin = u32(clamp(luma * 255.0, 0.0, 255.0));
  atomicAdd(&histogram[bin], 1u);

  // Accumulate total luminance
  atomicAdd(&histogram[256u], u32(luma * 1000.0));
  atomicAdd(&histogram[257u], 1u);
}

// ═══════════════════════════════════════════════════════════════
// PASS 2: ACES Tone Mapping + Auto-Exposure
// ═══════════════════════════════════════════════════════════════
//
// Applies ACES filmic tone mapping with auto-exposure derived
// from the histogram. Includes saturation boost and optional
// warm color grading for surveillance aesthetics.
//
// Bindings (group 1):
//   binding 0: histogramRead (storage, read) — histogram from pass 1
//   binding 1: outputTex (texture_storage_2d<rgba8unorm, write>)
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var<storage, read> histogramRead: array<u32>;
@group(1) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

// ACES filmic tone mapping approximation (Narkowicz 2015)
fn acesTonemap(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3(0.0), vec3(1.0));
}

// Reinhard extended tone mapping (preserves more highlights)
fn reinhardExtended(x: vec3<f32>, whitePoint: f32) -> vec3<f32> {
  let wp2 = whitePoint * whitePoint;
  let numerator = x * (vec3(1.0) + x / wp2);
  let denominator = vec3(1.0) + x;
  return numerator / denominator;
}

@compute @workgroup_size(8, 8)
fn hdr_tonemap(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let color = textureLoad(srcTexture, coord, 0).rgb;

  // Compute auto-exposure from histogram average luminance
  let lumaSum = f32(histogramRead[256u]) / 1000.0;
  let pixelCount = f32(max(histogramRead[257u], 1u));
  let avgLuma = lumaSum / pixelCount;

  // Target middle-gray exposure (0.18 key value)
  let keyValue = 0.18;
  let autoExposure = keyValue / max(avgLuma, 0.001);
  let finalExposure = autoExposure * params.exposure;

  // Apply exposure
  var exposed = color * finalExposure;

  // Apply contrast around middle gray
  let midGray = vec3(0.18);
  exposed = midGray + (exposed - midGray) * params.contrast;
  exposed = max(exposed, vec3(0.0));

  // ACES tone mapping
  var mapped = acesTonemap(exposed);

  // Saturation adjustment
  let mappedLuma = hdrLuma(mapped);
  mapped = mix(vec3(mappedLuma), mapped, params.saturation);

  // Mild warm color grade (subtle shift toward warm tones)
  mapped.r = mapped.r * 1.02;
  mapped.b = mapped.b * 0.98;

  // sRGB gamma (approximate)
  mapped = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));

  textureStore(outputTex, coord, vec4<f32>(clamp(mapped, vec3(0.0), vec3(1.0)), 1.0));
}
