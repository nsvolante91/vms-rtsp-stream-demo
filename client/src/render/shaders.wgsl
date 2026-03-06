struct ViewportUniforms {
  offset: vec2<f32>,
  scale: vec2<f32>,
  texelSize: vec2<f32>,   // 1/videoWidth, 1/videoHeight
  mode: f32,              // 0=off, 1=cas, 2=fsr
  sharpness: f32,         // 0..1
  uvOffset: vec2<f32>,    // zoom: UV sub-region offset (0,0 = no zoom)
  uvScale: vec2<f32>,     // zoom: UV sub-region scale (1,1 = no zoom)
};

@group(0) @binding(2) var<uniform> viewport: ViewportUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // 4 vertices for triangle strip quad covering clip space
  var pos = array<vec2<f32>, 4>(
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0),
  );
  var uv = array<vec2<f32>, 4>(
    vec2(0.0, 1.0),
    vec2(1.0, 1.0),
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
  );

  var p = pos[vertexIndex];
  p = p * viewport.scale + viewport.offset;

  var output: VertexOutput;
  output.position = vec4<f32>(p, 0.0, 1.0);
  output.texCoord = uv[vertexIndex];
  return output;
}

@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var texVideo: texture_external;

// ─── CAS: Contrast Adaptive Sharpening (5-tap) ────────────────
// Derived from AMD FidelityFX CAS. Sharpens low-contrast areas
// while preserving edges, using a cross-shaped sampling pattern.
fn applyCAS(uv: vec2<f32>) -> vec4<f32> {
  let ts = viewport.texelSize;
  let c = textureSampleBaseClampToEdge(texVideo, texSampler, uv).rgb;
  let t = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(0.0, -ts.y)).rgb;
  let b = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(0.0, ts.y)).rgb;
  let r = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(ts.x, 0.0)).rgb;
  let l = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(-ts.x, 0.0)).rgb;

  let mn = min(c, min(min(t, b), min(r, l)));
  let mx = max(c, max(max(t, b), max(r, l)));

  // AMD CAS weight: stronger sharpening in low-contrast regions
  let amp = clamp(min(mn, 2.0 - mx) / mx, vec3(0.0), vec3(1.0));
  let w = amp * vec3(-1.0 / mix(8.0, 5.0, viewport.sharpness));

  return vec4(clamp((c + (t + b + r + l) * w) / (1.0 + 4.0 * w), vec3(0.0), vec3(1.0)), 1.0);
}

// ─── FSR: Edge-Aware Upscale + RCAS (9-tap) ───────────────────
// Inspired by AMD FSR 1.0 (EASU + RCAS). Uses a 3×3 neighborhood
// for Sobel edge detection, then applies contrast-adaptive
// sharpening that backs off on strong edges to avoid halos.
fn applyFSR(uv: vec2<f32>) -> vec4<f32> {
  let ts = viewport.texelSize;

  // 3×3 neighborhood
  let tl = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(-ts.x, -ts.y)).rgb;
  let tc = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(0.0,   -ts.y)).rgb;
  let tr = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2( ts.x, -ts.y)).rgb;
  let ml = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(-ts.x,  0.0)).rgb;
  let mc = textureSampleBaseClampToEdge(texVideo, texSampler, uv).rgb;
  let mr = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2( ts.x,  0.0)).rgb;
  let bl = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(-ts.x,  ts.y)).rgb;
  let bc = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2(0.0,    ts.y)).rgb;
  let br = textureSampleBaseClampToEdge(texVideo, texSampler, uv + vec2( ts.x,  ts.y)).rgb;

  // Luma for edge analysis (BT.601)
  let lumaTL = dot(tl, vec3(0.299, 0.587, 0.114));
  let lumaTC = dot(tc, vec3(0.299, 0.587, 0.114));
  let lumaTR = dot(tr, vec3(0.299, 0.587, 0.114));
  let lumaML = dot(ml, vec3(0.299, 0.587, 0.114));
  let lumaMR = dot(mr, vec3(0.299, 0.587, 0.114));
  let lumaBL = dot(bl, vec3(0.299, 0.587, 0.114));
  let lumaBC = dot(bc, vec3(0.299, 0.587, 0.114));
  let lumaBR = dot(br, vec3(0.299, 0.587, 0.114));

  // Sobel edge magnitude
  let edgeH = abs(-lumaTL - 2.0*lumaTC - lumaTR + lumaBL + 2.0*lumaBC + lumaBR);
  let edgeV = abs(-lumaTL - 2.0*lumaML - lumaBL + lumaTR + 2.0*lumaMR + lumaBR);
  let edgeMag = edgeH + edgeV;

  // Cross and full neighborhood bounds
  let crossMn = min(mc, min(min(tc, bc), min(ml, mr)));
  let crossMx = max(mc, max(max(tc, bc), max(ml, mr)));
  let fullMn = min(crossMn, min(min(tl, tr), min(bl, br)));
  let fullMx = max(crossMx, max(max(tl, tr), max(bl, br)));

  // Reduce sharpening on strong edges to prevent ringing/halos
  let edgeFactor = 1.0 - clamp(edgeMag * 3.0, 0.0, 0.8);
  let adaptiveSharp = viewport.sharpness * edgeFactor;

  // RCAS-style weight from cross neighborhood contrast
  let amp = clamp(min(crossMn, 2.0 - crossMx) / crossMx, vec3(0.0), vec3(1.0));
  let w = amp * vec3(-1.0 / mix(5.0, 2.0, adaptiveSharp));

  let sharp = (mc + (tc + bc + ml + mr) * w) / (1.0 + 4.0 * w);
  return vec4(clamp(sharp, fullMn, fullMx), 1.0);
}

@fragment
fn fragmentMain(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
  // Apply zoom: map [0,1] UV to the cropped sub-region of the video
  let zoomedUV = viewport.uvOffset + texCoord * viewport.uvScale;

  let m = u32(viewport.mode);
  if (m == 1u) {
    return applyCAS(zoomedUV);
  } else if (m == 2u) {
    return applyFSR(zoomedUV);
  }
  return textureSampleBaseClampToEdge(texVideo, texSampler, zoomedUV);
}
