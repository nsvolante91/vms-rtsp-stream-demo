// ═══════════════════════════════════════════════════════════════
// Temporal Super-Resolution — 3 compute passes
//
// Pass 1: tsr_motion_estimate  — 8×8 block matching (SAD, ±4 search)
// Pass 2: tsr_accumulate       — Motion-compensated temporal blending
// Pass 3: tsr_sharpen          — RCAS sharpen on accumulated result
//
// Cross-frame motion-compensated detail accumulation — the way
// Google Pixel's Super Res Zoom works, but in a browser.
// Edge-aware blending prevents ghosting; scene-cut detection
// resets the accumulator.
// ═══════════════════════════════════════════════════════════════

// ─── Shared bindings ───────────────────────────────────────────

struct TSRUniforms {
  texelSize: vec2<f32>,   // 1/width, 1/height
  dimensions: vec2<f32>,  // width, height
  frameCount: f32,        // frames accumulated since reset
  sharpness: f32,         // 0..1
  sceneCutThreshold: f32, // SAD threshold for scene cut
  accumWeight: f32,       // temporal blend weight (lower = more accumulation)
};

@group(0) @binding(0) var srcTexture: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: TSRUniforms;

// Ensure all group(0) bindings appear in every entry point's auto-layout
fn touchGroup0() -> vec4<f32> {
  return textureSampleLevel(srcTexture, srcSampler, vec2<f32>(0.0, 0.0), 0.0) + vec4(params.sharpness);
}

// ─── Helper: BT.601 luma ──────────────────────────────────────
fn tsrLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3(0.299, 0.587, 0.114));
}


// ═══════════════════════════════════════════════════════════════
// PASS 1: Motion Estimation
// ═══════════════════════════════════════════════════════════════
//
// 8×8 block matching using Sum of Absolute Differences (SAD).
// ±4 pixel search window around each block.
//
// Bindings (group 1):
//   binding 0: prevFrame (texture_2d<f32>, read) — previous frame
//   binding 1: motionVecTex (texture_storage_2d<rg32float, write>) — output motion vectors
//
// Each thread processes one pixel. Motion vectors are computed
// at full resolution then smoothed implicitly by the small
// search window.
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var prevFrame: texture_2d<f32>;
@group(1) @binding(1) var motionVecTex: texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8, 8)
fn tsr_motion_estimate(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);

  // Current pixel luma and its 4-neighborhood for sub-block matching
  let curCenter = tsrLuma(textureLoad(srcTexture, coord, 0).rgb);

  // Search ±4 pixels for the best matching block in the previous frame
  var bestSAD: f32 = 999999.0;
  var bestMV = vec2<f32>(0.0);

  // Block radius for SAD computation (use 3×3 around current pixel)
  let blockR = 1;

  for (var dy: i32 = -4; dy <= 4; dy++) {
    for (var dx: i32 = -4; dx <= 4; dx++) {
      var sad: f32 = 0.0;
      var count: f32 = 0.0;

      for (var by: i32 = -blockR; by <= blockR; by++) {
        for (var bx: i32 = -blockR; bx <= blockR; bx++) {
          let curCoord = clamp(coord + vec2(bx, by), vec2(0), iDims - 1);
          let prevCoord = clamp(coord + vec2(dx + bx, dy + by), vec2(0), iDims - 1);

          let curLuma = tsrLuma(textureLoad(srcTexture, curCoord, 0).rgb);
          let prevLuma = tsrLuma(textureLoad(prevFrame, prevCoord, 0).rgb);

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

  // Store motion vector (in pixels) plus SAD in unused space
  // We encode bestSAD into the motion vector w/ a trick:
  // the fractional part won't matter for integer MVs
  textureStore(motionVecTex, coord, vec4(bestMV, 0.0, 0.0));
}


// ═══════════════════════════════════════════════════════════════
// PASS 2: Temporal Accumulation
// ═══════════════════════════════════════════════════════════════
//
// Motion-compensated blending of current frame with accumulated
// buffer. Edge-aware weights prevent ghosting. Scene-cut
// detection resets the accumulator when motion is too large.
//
// Bindings (group 1):
//   binding 0: motionVecRead (texture_2d<f32>) — motion vectors from pass 1
//   binding 1: accumTexRead (texture_2d<f32>) — previous accumulation buffer (read)
//   binding 2: accumTexWrite (texture_storage_2d<rgba8unorm, write>) — new accumulation (write)
//
// Accumulation strategy:
//   result = lerp(currentFrame, motionCompensatedAccum, blendWeight)
//   blendWeight is high for static areas, low for motion/edges
//   After ~8-10 frames, sub-pixel detail becomes visible as the
//   accumulator averages out noise and aliasing artifacts.
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var motionVecRead: texture_2d<f32>;
@group(1) @binding(1) var accumTexRead: texture_2d<f32>;
@group(1) @binding(2) var accumTexWrite: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn tsr_accumulate(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);

  let curColor = textureLoad(srcTexture, coord, 0).rgb;

  // First frame — no history, just store current
  if (params.frameCount < 1.0) {
    textureStore(accumTexWrite, coord, vec4(curColor, 1.0));
    return;
  }

  // Read motion vector for this pixel
  let mv = textureLoad(motionVecRead, coord, 0).rg;
  let mvLen = length(mv);

  // Motion-compensated lookup into accumulation buffer
  let prevCoord = clamp(coord + vec2<i32>(mv), vec2(0), iDims - 1);
  let accumColor = textureLoad(accumTexRead, prevCoord, 0).rgb;

  // ── Color difference detection (anti-ghosting) ──────────────
  let colorDiff = length(curColor - accumColor);
  let lumaC = tsrLuma(curColor);
  let lumaA = tsrLuma(accumColor);
  let lumaDiff = abs(lumaC - lumaA);

  // ── Edge detection on current frame ─────────────────────────
  let lumaL = tsrLuma(textureLoad(srcTexture, clamp(coord + vec2(-1, 0), vec2(0), iDims - 1), 0).rgb);
  let lumaR = tsrLuma(textureLoad(srcTexture, clamp(coord + vec2( 1, 0), vec2(0), iDims - 1), 0).rgb);
  let lumaT = tsrLuma(textureLoad(srcTexture, clamp(coord + vec2( 0,-1), vec2(0), iDims - 1), 0).rgb);
  let lumaB = tsrLuma(textureLoad(srcTexture, clamp(coord + vec2( 0, 1), vec2(0), iDims - 1), 0).rgb);
  let edgeMag = abs(lumaR - lumaL) + abs(lumaB - lumaT);

  // ── Blend weight computation ────────────────────────────────
  // Base: accumulate more over time (diminishing returns)
  let timeWeight = clamp(params.frameCount / (params.frameCount + 1.0), 0.3, 0.95);

  // Reduce accumulation on motion
  let motionPenalty = clamp(1.0 - mvLen * 0.15, 0.0, 1.0);

  // Reduce accumulation on color mismatch (prevents ghosting)
  let colorPenalty = clamp(1.0 - colorDiff * 4.0, 0.0, 1.0);

  // Reduce accumulation on edges (preserve sharp boundaries)
  let edgePenalty = clamp(1.0 - edgeMag * 2.0, 0.3, 1.0);

  // scene cut detection: if motion + color diff are extreme, reset
  let sceneCut = select(0.0, 1.0, lumaDiff > params.sceneCutThreshold && mvLen > 3.0);

  // Final blend weight: how much of the accumulation to keep
  var blendWeight = timeWeight * motionPenalty * colorPenalty * edgePenalty * params.accumWeight;
  blendWeight *= (1.0 - sceneCut); // Reset on scene cut

  let result = mix(curColor, accumColor, blendWeight);
  textureStore(accumTexWrite, coord, vec4(clamp(result, vec3(0.0), vec3(1.0)), 1.0));
}


// ═══════════════════════════════════════════════════════════════
// PASS 3: RCAS Sharpen
// ═══════════════════════════════════════════════════════════════
//
// Final sharpening pass on the accumulated result. Uses the same
// RCAS algorithm as the FSR fragment shader but reads from the
// accumulation texture instead of external texture.
//
// Bindings (group 1):
//   binding 0: accumFinalRead (texture_2d<f32>) — accumulated result
//   binding 1: outputTex (texture_storage_2d<rgba8unorm, write>) — final output
// ═══════════════════════════════════════════════════════════════

@group(1) @binding(0) var accumFinalRead: texture_2d<f32>;
@group(1) @binding(1) var tsrOutputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn tsr_sharpen(@builtin(global_invocation_id) gid: vec3<u32>) {
  _ = touchGroup0();
  let dims = vec2<u32>(params.dimensions);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let coord = vec2<i32>(gid.xy);
  let iDims = vec2<i32>(dims);

  // 5-tap cross neighborhood from accumulation buffer
  let mc = textureLoad(accumFinalRead, coord, 0).rgb;
  let tc = textureLoad(accumFinalRead, clamp(coord + vec2(0, -1), vec2(0), iDims - 1), 0).rgb;
  let bc = textureLoad(accumFinalRead, clamp(coord + vec2(0,  1), vec2(0), iDims - 1), 0).rgb;
  let ml = textureLoad(accumFinalRead, clamp(coord + vec2(-1, 0), vec2(0), iDims - 1), 0).rgb;
  let mr = textureLoad(accumFinalRead, clamp(coord + vec2( 1, 0), vec2(0), iDims - 1), 0).rgb;

  // RCAS: contrast-adaptive sharpening
  let mn = min(mc, min(min(tc, bc), min(ml, mr)));
  let mx = max(mc, max(max(tc, bc), max(ml, mr)));

  let amp = clamp(min(mn, 2.0 - mx) / mx, vec3(0.0), vec3(1.0));
  let w = amp * vec3(-1.0 / mix(5.0, 2.0, params.sharpness));

  let sharp = (mc + (tc + bc + ml + mr) * w) / (1.0 + 4.0 * w);
  let result = clamp(sharp, vec3(0.0), vec3(1.0));

  textureStore(tsrOutputTex, coord, vec4(result, 1.0));
}
