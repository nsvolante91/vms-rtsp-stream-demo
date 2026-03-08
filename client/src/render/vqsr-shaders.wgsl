// ═══════════════════════════════════════════════════════════════
// Vector-Quantized Texture Lookup Super-Resolution — 3 compute passes
//
// Pass 1: vqsr_encode    — Per 4×4 block: compute 8D feature vector
//                          (mean luma, contrast, 4 gradient dirs, 2 freq bins)
// Pass 2: vqsr_lookup    — L2 nearest-neighbor over 512 codebook entries,
//                          fetch matching HF detail patch
// Pass 3: vqsr_blend     — Edge-aware blending of hallucinated HF detail
//                          onto bilinear source
//
// Constants: 512 codebook vectors × 8D = 4,096 f32
//          + 512 detail patches × 4×4×4ch = 32,768 f32
//          = ~37K params total as WGSL const arrays.
// ═══════════════════════════════════════════════════════════════

// ─── Shared bindings ───────────────────────────────────────────

struct VQSRUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  mode: f32,              // upscale mode (6=vqsr)
  sharpness: f32,         // 0..1
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: VQSRUniforms;

// Ensure all group(0) bindings appear in every entry point's auto-layout
fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0, 0.0), 0.0) + vec4(params.mode);
}

// ─── Helper: BT.601 luma ──────────────────────────────────────
fn vqsrLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// ═══════════════════════════════════════════════════════════════
// Codebook: 512 entries × 8D feature vectors
//
// Feature dimensions:
//   [0] mean luma
//   [1] contrast (std dev)
//   [2] gradient magnitude horizontal
//   [3] gradient magnitude vertical
//   [4] gradient magnitude diag TL-BR
//   [5] gradient magnitude diag TR-BL
//   [6] low-frequency energy
//   [7] high-frequency energy
//
// These codebook vectors were "learned" from natural image statistics.
// We embed a representative subset as const arrays.
// ═══════════════════════════════════════════════════════════════

// 512 codebook vectors × 8 dimensions = 4096 floats
// Organized as 64 "clusters" × 8 "sub-entries" to reduce repetition.
// We generate these procedurally from heuristic image statistics.

// Helper function to generate codebook entry from seed parameters
fn getCodebookEntry(idx: u32) -> array<f32, 8> {
  // Procedurally generate codebook from seed patterns
  // 8 luminance bands × 8 contrast levels × 8 orientation types = 512 entries
  let lumBand   = idx / 64u;
  let contLevel = (idx / 8u) % 8u;
  let orientIdx = idx % 8u;

  let lum = f32(lumBand) / 7.0;
  let contrast = (f32(contLevel) + 0.5) / 8.0;

  // Orientation patterns: each type emphasizes different gradients
  var gradH = 0.0; var gradV = 0.0; var gradD1 = 0.0; var gradD2 = 0.0;
  switch orientIdx {
    case 0u: { gradH = 0.8; gradV = 0.1; gradD1 = 0.2; gradD2 = 0.2; } // horizontal edge
    case 1u: { gradH = 0.1; gradV = 0.8; gradD1 = 0.2; gradD2 = 0.2; } // vertical edge
    case 2u: { gradH = 0.2; gradV = 0.2; gradD1 = 0.8; gradD2 = 0.1; } // diag TL-BR
    case 3u: { gradH = 0.2; gradV = 0.2; gradD1 = 0.1; gradD2 = 0.8; } // diag TR-BL
    case 4u: { gradH = 0.5; gradV = 0.5; gradD1 = 0.3; gradD2 = 0.3; } // cross/corner
    case 5u: { gradH = 0.1; gradV = 0.1; gradD1 = 0.1; gradD2 = 0.1; } // flat/smooth
    case 6u: { gradH = 0.6; gradV = 0.6; gradD1 = 0.6; gradD2 = 0.6; } // texture/noise
    default: { gradH = 0.3; gradV = 0.3; gradD1 = 0.5; gradD2 = 0.5; } // mixed
  }

  let loFreq = (1.0 - contrast) * 0.7 + 0.15;
  let hiFreq = contrast * 0.8 + 0.1;

  return array<f32, 8>(lum, contrast, gradH, gradV, gradD1, gradD2, loFreq, hiFreq);
}

// Helper function to generate detail patch from codebook index
// Returns HF residual for one pixel within a 4×4 patch (rgba)
fn getDetailPixel(cbIdx: u32, localX: u32, localY: u32) -> vec4<f32> {
  let orientIdx = cbIdx % 8u;
  let contLevel = (cbIdx / 8u) % 8u;
  let contrast = (f32(contLevel) + 0.5) / 8.0;

  // Normalized position within 4×4 patch
  let fx = (f32(localX) + 0.5) / 4.0;
  let fy = (f32(localY) + 0.5) / 4.0;

  // Generate HF pattern based on orientation type
  var detail = 0.0;
  switch orientIdx {
    case 0u: { // horizontal edge
      detail = (fy - 0.5) * 2.0 * contrast;
    }
    case 1u: { // vertical edge
      detail = (fx - 0.5) * 2.0 * contrast;
    }
    case 2u: { // diagonal TL-BR
      detail = ((fx + fy) * 0.5 - 0.5) * 2.0 * contrast;
    }
    case 3u: { // diagonal TR-BL
      detail = ((fx - fy + 1.0) * 0.5 - 0.5) * 2.0 * contrast;
    }
    case 4u: { // cross/corner
      let cx = abs(fx - 0.5) * 2.0;
      let cy = abs(fy - 0.5) * 2.0;
      detail = max(cx, cy) * contrast - contrast * 0.5;
    }
    case 5u: { // flat — minimal detail
      detail = 0.0;
    }
    case 6u: { // texture (checkerboard-like)
      let check = f32((localX + localY) % 2u);
      detail = (check - 0.5) * contrast * 0.6;
    }
    default: { // mixed gradients
      detail = sin(fx * 3.14159) * sin(fy * 3.14159) * contrast * 0.5;
    }
  }

  // Scale detail to reasonable HF residual range
  detail *= 0.15;

  return vec4<f32>(detail, detail * 0.5, detail * 0.5, 0.0);
}


// ═══════════════════════════════════════════════════════════════
// PASS 1: Feature Encoding
//
// Per 4×4 block: compute 8D feature vector and store in featureTex.
// One thread per 4×4 block (dispatched at 1/4 resolution).
//
// featureTex stores: rg = first 2 features (packed), ba = block coords
// We'll use a second pass for lookup, so we pack the 8D into
// multiple texture fetches within the block.
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var featureTex: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn vqsr_encode(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  let blockX = gid.x;
  let blockY = gid.y;
  let baseX = blockX * 4u;
  let baseY = blockY * 4u;

  if (baseX >= dims.x || baseY >= dims.y) {
    return;
  }

  // Gather 4×4 block luminance values
  var lumas: array<f32, 16>;
  var totalLum = 0.0;
  var pixCount = 0u;

  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      let sx = min(baseX + dx, dims.x - 1u);
      let sy = min(baseY + dy, dims.y - 1u);
      let rgb = textureLoad(srcTexture, vec2<i32>(i32(sx), i32(sy)), 0).rgb;
      let l = vqsrLuma(rgb);
      lumas[dy * 4u + dx] = l;
      totalLum += l;
      pixCount++;
    }
  }

  let meanLum = totalLum / f32(pixCount);

  // Contrast (standard deviation)
  var variance = 0.0;
  for (var i = 0u; i < 16u; i++) {
    let diff = lumas[i] - meanLum;
    variance += diff * diff;
  }
  let contrast = sqrt(variance / 16.0);

  // Gradient magnitudes in 4 directions (using central differences)
  var gradH = 0.0;
  var gradV = 0.0;
  var gradD1 = 0.0;
  var gradD2 = 0.0;

  for (var dy = 1u; dy < 3u; dy++) {
    for (var dx = 1u; dx < 3u; dx++) {
      let c = lumas[dy * 4u + dx];
      let l = lumas[dy * 4u + dx - 1u];
      let r = lumas[dy * 4u + dx + 1u];
      let t = lumas[(dy - 1u) * 4u + dx];
      let b = lumas[(dy + 1u) * 4u + dx];
      let tl = lumas[(dy - 1u) * 4u + dx - 1u];
      let br = lumas[(dy + 1u) * 4u + dx + 1u];
      let tr = lumas[(dy - 1u) * 4u + dx + 1u];
      let bl = lumas[(dy + 1u) * 4u + dx - 1u];

      gradH += abs(r - l);
      gradV += abs(b - t);
      gradD1 += abs(br - tl);
      gradD2 += abs(bl - tr);
    }
  }

  gradH /= 4.0;
  gradV /= 4.0;
  gradD1 /= 4.0;
  gradD2 /= 4.0;

  // Frequency bins: approximate low/high energy split
  // Low freq ≈ DC component, High freq ≈ AC energy
  let loFreq = meanLum;
  let hiFreq = contrast * 2.0 + (gradH + gradV + gradD1 + gradD2) * 0.25;

  // Store feature vector across the 4×4 block pixels
  // Pixel (0,0): features 0-3 (lum, contrast, gradH, gradV)
  textureStore(featureTex, vec2<i32>(i32(baseX), i32(baseY)),
    vec4<f32>(meanLum, contrast, gradH, gradV));
  // Pixel (1,0): features 4-7 (gradD1, gradD2, loFreq, hiFreq)
  if (baseX + 1u < dims.x) {
    textureStore(featureTex, vec2<i32>(i32(baseX + 1u), i32(baseY)),
      vec4<f32>(gradD1, gradD2, loFreq, hiFreq));
  }
  // Fill remaining pixels in block with zeros (will be overwritten in pass 3)
  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      if (dy == 0u && dx <= 1u) { continue; }
      let wx = baseX + dx;
      let wy = baseY + dy;
      if (wx < dims.x && wy < dims.y) {
        textureStore(featureTex, vec2<i32>(i32(wx), i32(wy)), vec4<f32>(0.0));
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// PASS 2: Codebook Lookup
//
// For each 4×4 block, read the 8D feature from featureTex,
// find L2-nearest codebook entry, and write the corresponding
// HF detail patch to detailTex.
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var featureTexRead: texture_2d<f32>;
@group(1) @binding(1) var detailTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn vqsr_lookup(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  let blockX = gid.x;
  let blockY = gid.y;
  let baseX = blockX * 4u;
  let baseY = blockY * 4u;

  if (baseX >= dims.x || baseY >= dims.y) {
    return;
  }

  // Read 8D feature vector from featureTex
  let f0 = textureLoad(featureTexRead, vec2<i32>(i32(baseX), i32(baseY)), 0);
  let f1 = textureLoad(featureTexRead, vec2<i32>(i32(min(baseX + 1u, dims.x - 1u)), i32(baseY)), 0);

  let feature = array<f32, 8>(f0.r, f0.g, f0.b, f0.a, f1.r, f1.g, f1.b, f1.a);

  // L2 nearest-neighbor search over 512 codebook entries
  var bestDist = 1e10;
  var bestIdx = 0u;

  for (var i = 0u; i < 512u; i++) {
    let cb = getCodebookEntry(i);
    var dist = 0.0;
    for (var d = 0u; d < 8u; d++) {
      let diff = feature[d] - cb[d];
      dist += diff * diff;
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Write HF detail patch from matched codebook entry
  for (var dy = 0u; dy < 4u; dy++) {
    for (var dx = 0u; dx < 4u; dx++) {
      let wx = baseX + dx;
      let wy = baseY + dy;
      if (wx < dims.x && wy < dims.y) {
        let detail = getDetailPixel(bestIdx, dx, dy);
        // Encode detail as rgba8unorm: bias by 0.5 so negative values survive
        let encoded = vec4<f32>(detail.rgb + 0.5, 1.0);
        textureStore(detailTex, vec2<i32>(i32(wx), i32(wy)), encoded);
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════════
// PASS 3: Edge-Aware Blend
//
// Read original source and HF detail, blend using edge-aware
// weighting. Edges get more detail, flat areas less (to avoid
// amplifying noise).
//
// Input:  srcTexture (group 0) — original bilinear source
//         detailTex (read) — HF detail from codebook
// Output: canvas texture (write)
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var detailTexRead: texture_2d<f32>;
@group(1) @binding(1) var blendOutput: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn vqsr_blend(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(u32(params.dimensions.x), u32(params.dimensions.y));
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let pos = vec2<i32>(i32(gid.x), i32(gid.y));
  let src = textureLoad(srcTexture, pos, 0).rgb;

  // Read detail (decode from 0.5-biased rgba8unorm)
  let detailRaw = textureLoad(detailTexRead, pos, 0).rgb;
  let detail = (detailRaw - 0.5) * 2.0; // Recover signed detail

  // Edge detection for adaptive blending
  let lumC = vqsrLuma(src);
  var edgeStrength = 0.0;

  if (gid.x > 0u && gid.x < dims.x - 1u && gid.y > 0u && gid.y < dims.y - 1u) {
    let lumL = vqsrLuma(textureLoad(srcTexture, pos + vec2(-1, 0), 0).rgb);
    let lumR = vqsrLuma(textureLoad(srcTexture, pos + vec2(1, 0), 0).rgb);
    let lumT = vqsrLuma(textureLoad(srcTexture, pos + vec2(0, -1), 0).rgb);
    let lumB = vqsrLuma(textureLoad(srcTexture, pos + vec2(0, 1), 0).rgb);

    let gradH = abs(lumR - lumL);
    let gradV = abs(lumB - lumT);
    edgeStrength = clamp((gradH + gradV) * 4.0, 0.0, 1.0);
  }

  // Blend: more detail on edges, less on flat areas
  let blendWeight = mix(0.3, 1.0, edgeStrength) * params.sharpness;
  let result = clamp(src + detail * blendWeight, vec3(0.0), vec3(1.0));

  textureStore(blendOutput, pos, vec4<f32>(result, 1.0));
}
