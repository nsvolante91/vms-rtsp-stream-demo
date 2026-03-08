// ═══════════════════════════════════════════════════════════════
// Spectral Frequency Hallucination — 3 compute passes
//
// Pass 1: spec_dct_forward   — 8×8 block DCT on Y/Cb/Cr
// Pass 2: spec_hallucinate   — Detect missing HF coefficients,
//                              fill using 1/f PSD model + orientation
//                              coherence from neighboring blocks
// Pass 3: spec_dct_inverse   — IDCT back to spatial, blend with
//                              source via sharpness slider
//
// Pure analytical — no learned weights, only DCT basis constants,
// 1/f falloff table, and orientation weights (~192 f32 params).
// ═══════════════════════════════════════════════════════════════

// ─── Shared bindings ───────────────────────────────────────────

struct SpecUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  mode: f32,              // upscale mode (5=spec)
  sharpness: f32,         // 0..1 blend strength
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: SpecUniforms;

// Ensure all group(0) bindings appear in every entry point's auto-layout
fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0, 0.0), 0.0) + vec4(params.mode);
}

// ─── Constants: 8×8 DCT basis row (1D) ────────────────────────
// C(u,x) = alpha(u) * cos(pi*(2x+1)*u / 16)
// Pre-computed for u=0..7, x=0..7 → 64 values (row-major: basis[u*8+x])
const DCT_BASIS = array<f32, 64>(
  // u=0 (DC)
  0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339,
  // u=1
  0.49039264, 0.41573481, 0.27778512, 0.09754516,-0.09754516,-0.27778512,-0.41573481,-0.49039264,
  // u=2
  0.46193977, 0.19134172,-0.19134172,-0.46193977,-0.46193977,-0.19134172, 0.19134172, 0.46193977,
  // u=3
  0.41573481,-0.09754516,-0.49039264,-0.27778512, 0.27778512, 0.49039264, 0.09754516,-0.41573481,
  // u=4
  0.35355339,-0.35355339,-0.35355339, 0.35355339, 0.35355339,-0.35355339,-0.35355339, 0.35355339,
  // u=5
  0.27778512,-0.49039264, 0.09754516, 0.41573481,-0.41573481,-0.09754516, 0.49039264,-0.27778512,
  // u=6
  0.19134172,-0.46193977, 0.46193977,-0.19134172,-0.19134172, 0.46193977,-0.46193977, 0.19134172,
  // u=7
  0.09754516,-0.27778512, 0.41573481,-0.49039264, 0.49039264,-0.41573481, 0.27778512,-0.09754516
);

// ─── 1/f falloff table for natural image PSD ──────────────────
// Expected energy at frequency (u,v) follows 1/f^beta with beta≈1.2
// Index = u*8+v, normalized so DC=1.0
const ONEOVERF_PSD = array<f32, 64>(
  1.000, 0.550, 0.360, 0.265, 0.208, 0.170, 0.143, 0.123,
  0.550, 0.388, 0.295, 0.232, 0.190, 0.160, 0.137, 0.119,
  0.360, 0.295, 0.245, 0.203, 0.172, 0.148, 0.129, 0.113,
  0.265, 0.232, 0.203, 0.175, 0.152, 0.133, 0.118, 0.105,
  0.208, 0.190, 0.172, 0.152, 0.135, 0.121, 0.108, 0.098,
  0.170, 0.160, 0.148, 0.133, 0.121, 0.109, 0.099, 0.090,
  0.143, 0.137, 0.129, 0.118, 0.108, 0.099, 0.091, 0.084,
  0.123, 0.119, 0.113, 0.105, 0.098, 0.090, 0.084, 0.078
);

// ─── Orientation weights — anisotropic HF coherence ───────────
// Weight how much to trust neighboring blocks' HF for each (u,v)
// Higher values for oriented frequencies (edges), lower for noise
const ORIENT_WEIGHTS = array<f32, 64>(
  0.00, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40,
  0.10, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50,
  0.15, 0.25, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60,
  0.20, 0.30, 0.40, 0.50, 0.55, 0.60, 0.65, 0.70,
  0.25, 0.35, 0.45, 0.55, 0.60, 0.65, 0.70, 0.75,
  0.30, 0.40, 0.50, 0.60, 0.65, 0.70, 0.75, 0.80,
  0.35, 0.45, 0.55, 0.65, 0.70, 0.75, 0.80, 0.85,
  0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90
);

// ─── Helper: RGB ↔ YCbCr (BT.601) ────────────────────────────
fn rgbToYCbCr(rgb: vec3<f32>) -> vec3<f32> {
  let y  =  0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  let cb = -0.169 * rgb.r - 0.331 * rgb.g + 0.500 * rgb.b + 0.5;
  let cr =  0.500 * rgb.r - 0.419 * rgb.g - 0.081 * rgb.b + 0.5;
  return vec3(y, cb, cr);
}

fn ycbcrToRGB(ycc: vec3<f32>) -> vec3<f32> {
  let y  = ycc.x;
  let cb = ycc.y - 0.5;
  let cr = ycc.z - 0.5;
  let r = y + 1.402 * cr;
  let g = y - 0.344 * cb - 0.714 * cr;
  let b = y + 1.772 * cb;
  return vec3(r, g, b);
}


// ═══════════════════════════════════════════════════════════════
// PASS 1: Forward DCT (8×8 blocks)
//
// For each 8×8 block, compute the 2D DCT of Y, Cb, Cr channels.
// Store coefficients in dctCoeffTex (rgba32float):
//   r = Y coefficient, g = Cb coefficient, b = Cr coefficient, a = 1.0
//
// One workgroup (8×8 threads) per block.
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var dctCoeffTex: texture_storage_2d<rgba32float, write>;

var<workgroup> blockY: array<array<f32, 8>, 8>;
var<workgroup> blockCb: array<array<f32, 8>, 8>;
var<workgroup> blockCr: array<array<f32, 8>, 8>;
var<workgroup> tempY: array<array<f32, 8>, 8>;
var<workgroup> tempCb: array<array<f32, 8>, 8>;
var<workgroup> tempCr: array<array<f32, 8>, 8>;

@compute @workgroup_size(8, 8)
fn spec_dct_forward(@builtin(global_invocation_id) gid: vec3<u32>,
                    @builtin(local_invocation_id) lid: vec3<u32>,
                    @builtin(workgroup_id) wgid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  let px = wgid.x * 8u + lid.x;
  let py = wgid.y * 8u + lid.y;

  // Load pixel and convert to YCbCr
  if (px < dims.x && py < dims.y) {
    let rgb = textureLoad(srcTexture, vec2<i32>(i32(px), i32(py)), 0).rgb;
    let ycc = rgbToYCbCr(rgb);
    blockY[lid.y][lid.x] = ycc.x;
    blockCb[lid.y][lid.x] = ycc.y;
    blockCr[lid.y][lid.x] = ycc.z;
  } else {
    blockY[lid.y][lid.x] = 0.0;
    blockCb[lid.y][lid.x] = 0.0;
    blockCr[lid.y][lid.x] = 0.0;
  }
  workgroupBarrier();

  // 1D DCT along rows: each thread (u, y) computes sum over x
  let u = lid.x;
  let row = lid.y;
  var sumY = 0.0;
  var sumCb = 0.0;
  var sumCr = 0.0;
  for (var x = 0u; x < 8u; x++) {
    let basis = DCT_BASIS[u * 8u + x];
    sumY  += blockY[row][x] * basis;
    sumCb += blockCb[row][x] * basis;
    sumCr += blockCr[row][x] * basis;
  }
  tempY[row][u] = sumY;
  tempCb[row][u] = sumCb;
  tempCr[row][u] = sumCr;
  workgroupBarrier();

  // 1D DCT along columns: each thread (u, v) computes sum over y
  let v = lid.y;
  var sumY2 = 0.0;
  var sumCb2 = 0.0;
  var sumCr2 = 0.0;
  for (var y = 0u; y < 8u; y++) {
    let basis = DCT_BASIS[v * 8u + y];
    sumY2  += tempY[y][u] * basis;
    sumCb2 += tempCb[y][u] * basis;
    sumCr2 += tempCr[y][u] * basis;
  }

  // Store DCT coefficients
  if (px < dims.x && py < dims.y) {
    textureStore(dctCoeffTex, vec2<i32>(i32(px), i32(py)), vec4<f32>(sumY2, sumCb2, sumCr2, 1.0));
  }
}


// ═══════════════════════════════════════════════════════════════
// PASS 2: Frequency Hallucination
//
// For each 8×8 block's DCT coefficients, detect which high-frequency
// bands are missing (magnitude below threshold) and synthesize
// plausible values using the 1/f PSD model.
//
// Orientation coherence: sample neighboring blocks' HF coefficients
// and blend to maintain directional consistency.
//
// Input:  dctCoeffTex (read)
// Output: dctFilledTex (write) — same format, with HF filled in
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var dctCoeffRead: texture_2d<f32>;
@group(1) @binding(1) var dctFilledTex: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn spec_hallucinate(@builtin(global_invocation_id) gid: vec3<u32>,
                    @builtin(local_invocation_id) lid: vec3<u32>,
                    @builtin(workgroup_id) wgid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  let px = wgid.x * 8u + lid.x;
  let py = wgid.y * 8u + lid.y;

  if (px >= dims.x || py >= dims.y) {
    return;
  }

  let u = lid.x;
  let v = lid.y;
  let freqIdx = v * 8u + u;

  // Read current coefficient
  let coeff = textureLoad(dctCoeffRead, vec2<i32>(i32(px), i32(py)), 0);
  var coeffY = coeff.r;
  var coeffCb = coeff.g;
  var coeffCr = coeff.b;

  // DC coefficient (0,0) — never hallucinate
  if (u == 0u && v == 0u) {
    textureStore(dctFilledTex, vec2<i32>(i32(px), i32(py)), vec4<f32>(coeffY, coeffCb, coeffCr, 1.0));
    return;
  }

  // Read DC coefficient for this block to estimate expected energy
  let blockBaseX = i32(wgid.x * 8u);
  let blockBaseY = i32(wgid.y * 8u);
  let dcCoeff = textureLoad(dctCoeffRead, vec2<i32>(blockBaseX, blockBaseY), 0);
  let dcEnergy = abs(dcCoeff.r);

  // Expected HF magnitude based on 1/f model
  let expectedMag = dcEnergy * ONEOVERF_PSD[freqIdx] * params.sharpness * 2.0;

  // Current magnitude
  let currentMag = abs(coeffY);

  // Threshold: if current magnitude is below 20% of expected, it's "missing"
  let threshold = expectedMag * 0.2;

  if (currentMag >= threshold) {
    // Coefficient is present — pass through unchanged
    textureStore(dctFilledTex, vec2<i32>(i32(px), i32(py)), vec4<f32>(coeffY, coeffCb, coeffCr, 1.0));
    return;
  }

  // ── Hallucinate missing HF from neighbors ───────────────────
  let orientW = ORIENT_WEIGHTS[freqIdx];

  // Sample same (u,v) coefficient from up to 4 neighboring blocks
  var neighborSum = 0.0;
  var neighborCount = 0.0;

  // Left neighbor block
  if (wgid.x > 0u) {
    let nc = textureLoad(dctCoeffRead, vec2<i32>(blockBaseX - 8 + i32(u), blockBaseY + i32(v)), 0);
    neighborSum += nc.r;
    neighborCount += 1.0;
  }
  // Right neighbor block
  if ((wgid.x + 1u) * 8u < dims.x) {
    let nc = textureLoad(dctCoeffRead, vec2<i32>(blockBaseX + 8 + i32(u), blockBaseY + i32(v)), 0);
    neighborSum += nc.r;
    neighborCount += 1.0;
  }
  // Top neighbor block
  if (wgid.y > 0u) {
    let nc = textureLoad(dctCoeffRead, vec2<i32>(blockBaseX + i32(u), blockBaseY - 8 + i32(v)), 0);
    neighborSum += nc.r;
    neighborCount += 1.0;
  }
  // Bottom neighbor block
  if ((wgid.y + 1u) * 8u < dims.y) {
    let nc = textureLoad(dctCoeffRead, vec2<i32>(blockBaseX + i32(u), blockBaseY + 8 + i32(v)), 0);
    neighborSum += nc.r;
    neighborCount += 1.0;
  }

  // Synthesized coefficient: blend between 1/f prediction and neighbor coherence
  var hallucinated = expectedMag * sign(coeffY + 0.001);
  if (neighborCount > 0.0) {
    let neighborAvg = neighborSum / neighborCount;
    hallucinated = mix(hallucinated, neighborAvg, orientW);
  }

  // Blend hallucinated with existing (keeps whatever was already there)
  let blended = mix(coeffY, hallucinated, 0.7);

  // Chroma: apply gentler fill (half strength)
  let chromaFill = 0.35;
  let filledCb = mix(coeffCb, coeffCb * (expectedMag / max(currentMag, 0.001)), chromaFill * params.sharpness);
  let filledCr = mix(coeffCr, coeffCr * (expectedMag / max(currentMag, 0.001)), chromaFill * params.sharpness);

  textureStore(dctFilledTex, vec2<i32>(i32(px), i32(py)), vec4<f32>(blended, filledCb, filledCr, 1.0));
}


// ═══════════════════════════════════════════════════════════════
// PASS 3: Inverse DCT + Blend
//
// IDCT the filled DCT coefficients back to spatial domain,
// then blend with the original source using the sharpness slider.
//
// Input:  dctFilledTex (read) — hallucinated DCT coefficients
//         srcTexture (group 0) — original source for blending
// Output: canvas texture (write)
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var dctFilledRead: texture_2d<f32>;
@group(1) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

var<workgroup> idctY: array<array<f32, 8>, 8>;
var<workgroup> idctCb: array<array<f32, 8>, 8>;
var<workgroup> idctCr: array<array<f32, 8>, 8>;
var<workgroup> itempY: array<array<f32, 8>, 8>;
var<workgroup> itempCb: array<array<f32, 8>, 8>;
var<workgroup> itempCr: array<array<f32, 8>, 8>;

@compute @workgroup_size(8, 8)
fn spec_dct_inverse(@builtin(global_invocation_id) gid: vec3<u32>,
                    @builtin(local_invocation_id) lid: vec3<u32>,
                    @builtin(workgroup_id) wgid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  let px = wgid.x * 8u + lid.x;
  let py = wgid.y * 8u + lid.y;

  // Load DCT coefficients into shared memory
  if (px < dims.x && py < dims.y) {
    let c = textureLoad(dctFilledRead, vec2<i32>(i32(px), i32(py)), 0);
    idctY[lid.y][lid.x] = c.r;
    idctCb[lid.y][lid.x] = c.g;
    idctCr[lid.y][lid.x] = c.b;
  } else {
    idctY[lid.y][lid.x] = 0.0;
    idctCb[lid.y][lid.x] = 0.0;
    idctCr[lid.y][lid.x] = 0.0;
  }
  workgroupBarrier();

  // Inverse 1D DCT along columns first: for each (x, y), sum over v
  let x = lid.x;
  let y = lid.y;
  var sumY = 0.0;
  var sumCb = 0.0;
  var sumCr = 0.0;
  for (var v = 0u; v < 8u; v++) {
    let basis = DCT_BASIS[v * 8u + y]; // IDCT uses same basis (orthogonal)
    sumY  += idctY[v][x] * basis;
    sumCb += idctCb[v][x] * basis;
    sumCr += idctCr[v][x] * basis;
  }
  itempY[y][x] = sumY;
  itempCb[y][x] = sumCb;
  itempCr[y][x] = sumCr;
  workgroupBarrier();

  // Inverse 1D DCT along rows: for each (x, y), sum over u
  var finalY = 0.0;
  var finalCb = 0.0;
  var finalCr = 0.0;
  for (var u = 0u; u < 8u; u++) {
    let basis = DCT_BASIS[u * 8u + x];
    finalY  += itempY[y][u] * basis;
    finalCb += itempCb[y][u] * basis;
    finalCr += itempCr[y][u] * basis;
  }

  if (px >= dims.x || py >= dims.y) {
    return;
  }

  // Convert back to RGB
  let reconstructed = ycbcrToRGB(vec3(finalY, finalCb, finalCr));

  // Read original source for blending
  let original = textureLoad(srcTexture, vec2<i32>(i32(px), i32(py)), 0).rgb;

  // Blend: sharpness controls how much hallucinated detail is mixed in
  let result = mix(original, clamp(reconstructed, vec3(0.0), vec3(1.0)), params.sharpness);

  textureStore(outputTex, vec2<i32>(i32(px), i32(py)), vec4<f32>(result, 1.0));
}
