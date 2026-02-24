struct ViewportUniforms {
  offset: vec2<f32>,
  scale: vec2<f32>,
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

@fragment
fn fragmentMain(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSampleBaseClampToEdge(texVideo, texSampler, texCoord);
}
