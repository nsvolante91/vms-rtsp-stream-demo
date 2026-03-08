// ─── DLSS-Style Upscaling (Mac-compatible WebGPU implementation) ───────────
//
// A 4-pass compute shader pipeline combining temporal accumulation with
// spatial super-resolution and neural-style detail hallucination.
// Works on any GPU (no NVIDIA Tensor Core requirement).
//
// Pass 1: dlss_motion_depth       — Motion estimation + edge-based depth hints
// Pass 2: dlss_temporal_accum_main — Motion-compensated temporal accumulation
// Pass 3: dlss_spatial_enhance    — Edge-directed spatial enhancement + detail synthesis
// Pass 4: dlss_final_reconstruct  — Combine temporal + spatial, sharpen, anti-ring

// ─── Shared Bindings (group 0) ────────────────────────────────────────────

struct DLSSUniforms {
  texelSize: vec2<f32>,    // 1/width, 1/height
  resolution: vec2<f32>,   // width, height
  frameCount: f32,         // temporal frame index
  sharpness: f32,          // 0..1 sharpness strength
  temporalWeight: f32,     // base temporal blend weight (0.85)
  sceneCutThresh: f32,     // SAD threshold for scene cut detection (0.3)
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: DLSSUniforms;

// Ensure all entry points include group(0) in their auto-layout
fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTex, samp, vec2<f32>(0.0, 0.0), 0.0) + vec4(params.sharpness);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

fn rgb2luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// ═══════════════════════════════════════════════════════════════════════════
// PASS 1: Motion Estimation + Edge Depth
// ═══════════════════════════════════════════════════════════════════════════
//
// Block-matching motion estimation at 8×8 granularity with ±4 search range.
// Also computes edge-based depth hints for depth-aware temporal blending.
//
// Group 1 bindings:
//   binding 0: prevFrame (texture_2d<f32>) — previous frame for motion matching
//   binding 1: motionVecs (texture_storage_2d<rg32float, write>) — output MVs
//   binding 2: depthHints (texture_storage_2d<r32float, write>) — edge depth

@group(1) @binding(0) var prevFrame: texture_2d<f32>;
@group(1) @binding(1) var motionVecs: texture_storage_2d<rg32float, write>;
@group(1) @binding(2) var depthHints: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn dlss_motion_depth(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(vec2<i32>(params.resolution));
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let px = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);
  let ts = params.texelSize;
  let uv = (vec2<f32>(gid.xy) + 0.5) * ts;

  // ── Block matching (3×3 block around pixel, ±4 search) ──
  var bestMV = vec2<f32>(0.0);
  var bestSAD: f32 = 999999.0;

  for (var dy: i32 = -4; dy <= 4; dy += 1) {
    for (var dx: i32 = -4; dx <= 4; dx += 1) {
      var sad: f32 = 0.0;
      var count: f32 = 0.0;

      for (var by: i32 = -1; by <= 1; by += 1) {
        for (var bx: i32 = -1; bx <= 1; bx += 1) {
          let curCoord = clamp(px + vec2(bx, by), vec2(0), iDims - 1);
          let prevCoord = clamp(px + vec2(dx + bx, dy + by), vec2(0), iDims - 1);

          let curLuma = rgb2luma(textureLoad(srcTex, curCoord, 0).rgb);
          let prevLuma = rgb2luma(textureLoad(prevFrame, prevCoord, 0).rgb);
          sad += abs(curLuma - prevLuma);
          count += 1.0;
        }
      }
      sad /= count;

      if (sad < bestSAD) {
        bestSAD = sad;
        bestMV = vec2<f32>(f32(dx), f32(dy));
      }
    }
  }

  textureStore(motionVecs, px, vec4(bestMV, 0.0, 0.0));

  // ── Edge-based depth hint ──
  // Strong edges → foreground (depth ≈ 0), smooth areas → background (depth ≈ 1)
  let lumaL = rgb2luma(textureLoad(srcTex, clamp(px + vec2(-1, 0), vec2(0), iDims - 1), 0).rgb);
  let lumaR = rgb2luma(textureLoad(srcTex, clamp(px + vec2( 1, 0), vec2(0), iDims - 1), 0).rgb);
  let lumaT = rgb2luma(textureLoad(srcTex, clamp(px + vec2( 0,-1), vec2(0), iDims - 1), 0).rgb);
  let lumaB = rgb2luma(textureLoad(srcTex, clamp(px + vec2( 0, 1), vec2(0), iDims - 1), 0).rgb);
  let edgeMag = clamp((abs(lumaR - lumaL) + abs(lumaB - lumaT)) * 5.0, 0.0, 1.0);
  let depth = 1.0 - edgeMag;

  textureStore(depthHints, px, vec4(depth, 0.0, 0.0, 0.0));
}


// ═══════════════════════════════════════════════════════════════════════════
// PASS 2: Temporal Accumulation
// ═══════════════════════════════════════════════════════════════════════════
//
// Motion-compensated blending with neighborhood clamping (anti-ghosting)
// and depth-aware temporal weight adjustment.
//
// Group 1 bindings:
//   binding 0: motionVecRead (texture_2d<f32>) — motion vectors from pass 1
//   binding 1: depthRead (texture_2d<f32>) — depth hints from pass 1
//   binding 2: accumIn (texture_2d<f32>) — previous accumulation buffer
//   binding 3: accumOut (texture_storage_2d<rgba8unorm, write>) — new accumulation

@group(1) @binding(0) var motionVecRead: texture_2d<f32>;
@group(1) @binding(1) var depthRead: texture_2d<f32>;
@group(1) @binding(2) var accumIn: texture_2d<f32>;
@group(1) @binding(3) var accumOut: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn dlss_temporal_accum_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(vec2<i32>(params.resolution));
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let px = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);

  let curColor = textureLoad(srcTex, px, 0).rgb;

  // First frame — no history
  if (params.frameCount < 1.0) {
    textureStore(accumOut, px, vec4(curColor, 1.0));
    return;
  }

  // Read motion vector and warp accumulation buffer
  let mv = textureLoad(motionVecRead, px, 0).xy;
  let prevCoord = clamp(px + vec2<i32>(mv), vec2(0), iDims - 1);
  let prevAccum = textureLoad(accumIn, prevCoord, 0).rgb;

  // Neighborhood clamping (anti-ghosting)
  var nbMin = curColor;
  var nbMax = curColor;
  for (var dy: i32 = -1; dy <= 1; dy += 1) {
    for (var dx: i32 = -1; dx <= 1; dx += 1) {
      if (dx == 0 && dy == 0) { continue; }
      let nbCoord = clamp(px + vec2(dx, dy), vec2(0), iDims - 1);
      let nb = textureLoad(srcTex, nbCoord, 0).rgb;
      nbMin = min(nbMin, nb);
      nbMax = max(nbMax, nb);
    }
  }
  let clampedHistory = clamp(prevAccum, nbMin, nbMax);

  // Depth-aware weight: foreground gets less temporal blending (reduces ghosting)
  let depth = textureLoad(depthRead, px, 0).r;
  let depthWeight = mix(0.6, 1.0, depth);

  // Scene cut detection
  let lumaDiff = abs(rgb2luma(curColor) - rgb2luma(clampedHistory));
  let mvLen = length(mv);
  let sceneCut = select(0.0, 1.0, lumaDiff > params.sceneCutThresh && mvLen > 3.0);

  // Motion penalty
  let motionPenalty = clamp(1.0 - mvLen * 0.1, 0.0, 1.0);

  // Color mismatch penalty
  let colorDiff = length(curColor - clampedHistory);
  let colorPenalty = clamp(1.0 - colorDiff * 3.0, 0.0, 1.0);

  // Frame ramp (build up slowly)
  let frameRamp = clamp(params.frameCount / 8.0, 0.0, 1.0);

  var blendWeight = params.temporalWeight * depthWeight * motionPenalty * colorPenalty * frameRamp;
  blendWeight *= (1.0 - sceneCut);

  let result = mix(curColor, clampedHistory, blendWeight);
  textureStore(accumOut, px, vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0));
}


// ═══════════════════════════════════════════════════════════════════════════
// PASS 3: Spatial Enhancement + Detail Synthesis
// ═══════════════════════════════════════════════════════════════════════════
//
// Edge-directed spatial enhancement with multi-directional gradient analysis.
// Synthesizes high-frequency detail based on local contrast and structure.
//
// Group 1 bindings:
//   binding 0: accumTex (texture_2d<f32>) — temporally accumulated result
//   binding 1: depthTex (texture_2d<f32>) — depth hints
//   binding 2: enhanced (texture_storage_2d<rgba8unorm, write>) — enhanced output

@group(1) @binding(0) var accumTex: texture_2d<f32>;
@group(1) @binding(1) var depthTex: texture_2d<f32>;
@group(1) @binding(2) var enhanced: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn dlss_spatial_enhance(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(vec2<i32>(params.resolution));
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let px = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);
  let ts = params.texelSize;
  let uv = (vec2<f32>(gid.xy) + 0.5) * ts;

  // Sample accumulated frame (temporally stable)
  let center = textureSampleLevel(accumTex, samp, uv, 0.0).rgb;

  // 3×3 neighborhood from accumulated buffer
  let tl = textureSampleLevel(accumTex, samp, uv + vec2(-ts.x, -ts.y), 0.0).rgb;
  let tc = textureSampleLevel(accumTex, samp, uv + vec2(0.0,   -ts.y), 0.0).rgb;
  let tr = textureSampleLevel(accumTex, samp, uv + vec2( ts.x, -ts.y), 0.0).rgb;
  let ml = textureSampleLevel(accumTex, samp, uv + vec2(-ts.x,  0.0),  0.0).rgb;
  let mr = textureSampleLevel(accumTex, samp, uv + vec2( ts.x,  0.0),  0.0).rgb;
  let bl = textureSampleLevel(accumTex, samp, uv + vec2(-ts.x,  ts.y), 0.0).rgb;
  let bc = textureSampleLevel(accumTex, samp, uv + vec2(0.0,    ts.y), 0.0).rgb;
  let br = textureSampleLevel(accumTex, samp, uv + vec2( ts.x,  ts.y), 0.0).rgb;

  // ── Gradient analysis ──
  let lumaTL = rgb2luma(tl); let lumaTC = rgb2luma(tc); let lumaTR = rgb2luma(tr);
  let lumaML = rgb2luma(ml); let lumaMC = rgb2luma(center); let lumaMR = rgb2luma(mr);
  let lumaBL = rgb2luma(bl); let lumaBC = rgb2luma(bc); let lumaBR = rgb2luma(br);

  // Sobel gradients
  let gx = (-lumaTL - 2.0 * lumaML - lumaBL + lumaTR + 2.0 * lumaMR + lumaBR);
  let gy = (-lumaTL - 2.0 * lumaTC - lumaTR + lumaBL + 2.0 * lumaBC + lumaBR);
  let edgeMag = sqrt(gx * gx + gy * gy);
  let edgeAngle = atan2(gy, gx);

  // ── Edge-directed interpolation ──
  // Sample along the edge to reduce staircase artifacts
  let perpDir = vec2<f32>(cos(edgeAngle + 1.5707963), sin(edgeAngle + 1.5707963));
  let along1 = textureSampleLevel(accumTex, samp, uv + perpDir * ts, 0.0).rgb;
  let along2 = textureSampleLevel(accumTex, samp, uv - perpDir * ts, 0.0).rgb;

  let edgeWeight = clamp(edgeMag * 3.0, 0.0, 0.7);
  let edgeDirected = mix(center, (along1 + along2) * 0.5, edgeWeight * 0.3);

  // ── Detail synthesis ──
  let localMean = (tl + tc + tr + ml + mr + bl + bc + br) * 0.125;
  let detail = center - localMean;

  // Contrast-adaptive detail amplification
  let localContrast = max(max(max(lumaTL, lumaTC), max(lumaTR, lumaML)),
                          max(max(lumaMR, lumaBL), max(lumaBC, lumaBR))) -
                      min(min(min(lumaTL, lumaTC), min(lumaTR, lumaML)),
                          min(min(lumaMR, lumaBL), min(lumaBC, lumaBR)));

  // Low contrast → moderate amplification, high contrast → suppress (avoid halos)
  let detailAmp = mix(0.8, 0.15, clamp(localContrast * 4.0, 0.0, 1.0));
  // Apply detail per-channel but limit magnitude to avoid colored spots
  let rawDetail = detail * detailAmp * params.sharpness;
  let synthDetail = clamp(rawDetail, vec3(-0.15), vec3(0.15));

  // ── Combine ──
  let depth = textureLoad(depthTex, px, 0).r;
  let spatialMix = mix(0.5, 0.2, depth); // foreground → more spatial enhancement

  let result = edgeDirected + synthDetail * spatialMix;
  textureStore(enhanced, px, vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0));
}


// ═══════════════════════════════════════════════════════════════════════════
// PASS 4: Final Reconstruction
// ═══════════════════════════════════════════════════════════════════════════
//
// Combines spatial enhancement with temporal accumulation,
// applies RCAS-style adaptive sharpening, and anti-ringing clamp.
//
// Group 1 bindings:
//   binding 0: enhancedTex (texture_2d<f32>) — spatially enhanced result
//   binding 1: accumFinal (texture_2d<f32>) — temporal accumulation
//   binding 2: output (texture_storage_2d<rgba8unorm, write>) — final output

@group(1) @binding(0) var enhancedTex: texture_2d<f32>;
@group(1) @binding(1) var accumFinal: texture_2d<f32>;
@group(1) @binding(2) var finalOutput: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn dlss_final_reconstruct(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(vec2<i32>(params.resolution));
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let px = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);
  let ts = params.texelSize;
  let uv = (vec2<f32>(gid.xy) + 0.5) * ts;

  // Read spatial enhancement and temporal accumulation
  let spatial = textureSampleLevel(enhancedTex, samp, uv, 0.0).rgb;
  let temporal = textureSampleLevel(accumFinal, samp, uv, 0.0).rgb;

  // Blend spatial + temporal (spatial has detail, temporal has stability)
  let combined = mix(temporal, spatial, 0.6);

  // ── RCAS-style adaptive sharpening (AMD FSR-safe) ──
  let t = textureSampleLevel(enhancedTex, samp, uv + vec2(0.0, -ts.y), 0.0).rgb;
  let b = textureSampleLevel(enhancedTex, samp, uv + vec2(0.0,  ts.y), 0.0).rgb;
  let l = textureSampleLevel(enhancedTex, samp, uv + vec2(-ts.x, 0.0), 0.0).rgb;
  let r = textureSampleLevel(enhancedTex, samp, uv + vec2( ts.x, 0.0), 0.0).rgb;

  let crossMn = min(combined, min(min(t, b), min(l, r)));
  let crossMx = max(combined, max(max(t, b), max(l, r)));

  // Safe: avoid division by zero, use sqrt per AMD RCAS spec,
  // and limit weight so denominator (1+4w) stays positive.
  let safeMx = max(crossMx, vec3(1.0 / 256.0));
  let amp = sqrt(clamp(min(crossMn, 2.0 - crossMx) / safeMx, vec3(0.0), vec3(1.0)));
  let w = amp * vec3(-0.25 * params.sharpness);

  let denom = max(1.0 + 4.0 * w, vec3(0.01));
  let sharp = (combined + (t + b + l + r) * w) / denom;

  // ── Anti-ringing: clamp to neighborhood of source ──
  let srcCenter = textureLoad(srcTex, px, 0).rgb;
  let srcT = textureLoad(srcTex, clamp(px + vec2(0, -1), vec2(0), iDims - 1), 0).rgb;
  let srcB = textureLoad(srcTex, clamp(px + vec2(0,  1), vec2(0), iDims - 1), 0).rgb;
  let srcL = textureLoad(srcTex, clamp(px + vec2(-1, 0), vec2(0), iDims - 1), 0).rgb;
  let srcR = textureLoad(srcTex, clamp(px + vec2( 1, 0), vec2(0), iDims - 1), 0).rgb;

  let srcMin = min(srcCenter, min(min(srcT, srcB), min(srcL, srcR))) - vec3(0.05);
  let srcMax = max(srcCenter, max(max(srcT, srcB), max(srcL, srcR))) + vec3(0.05);

  let antiRinged = clamp(sharp, srcMin, srcMax);

  // Soft blend: further from source → more anti-ringing
  let dist = length(sharp - srcCenter);
  let clampBlend = clamp(dist * 5.0, 0.0, 1.0);
  let result = mix(sharp, antiRinged, clampBlend * 0.7);

  textureStore(finalOutput, px, vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0));
}
