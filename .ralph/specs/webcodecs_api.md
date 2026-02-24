# WebCodecs + WebGPU API Quick Reference

## WebCodecs VideoDecoder

### Configuration

```typescript
// Check if codec is supported (ALWAYS check before configuring)
const support = await VideoDecoder.isConfigSupported({
  codec: 'avc1.64001f',  // H.264 High Profile, Level 3.1
  codedWidth: 1920,
  codedHeight: 1080,
  hardwareAcceleration: 'prefer-hardware',
});
// support.supported === true/false
// support.config contains the validated config

// Configure decoder
const decoder = new VideoDecoder({
  output: (frame: VideoFrame) => {
    // frame is GPU-backed when hardware acceleration is active
    // MUST call frame.close() when done
  },
  error: (e: DOMException) => {
    console.error('Decode error:', e.message);
  },
});

decoder.configure({
  codec: 'avc1.64001f',
  codedWidth: 1920,
  codedHeight: 1080,
  hardwareAcceleration: 'prefer-hardware',
  optimizeForLatency: true,  // Reduces decode buffering
});
```

### Feeding Frames

```typescript
const chunk = new EncodedVideoChunk({
  type: isKeyframe ? 'key' : 'delta',
  timestamp: presentationTimestamp,  // microseconds
  data: h264AnnexBData,  // Uint8Array with 0x00000001 start codes
});

// BACKPRESSURE CHECK
if (decoder.decodeQueueSize <= 3) {
  decoder.decode(chunk);
} else {
  // Drop non-keyframe to prevent queue buildup
  if (chunk.type !== 'key') {
    // Log as dropped frame
  } else {
    decoder.decode(chunk); // Never drop keyframes
  }
}
```

### H.264 Codec String Generation

```typescript
// Parse SPS NAL unit to extract codec parameters
function generateCodecString(sps: Uint8Array): string {
  // SPS NAL unit structure (after NAL header byte):
  // byte 0: profile_idc
  // byte 1: constraint_set flags (constraint_set0..5_flag + reserved)
  // byte 2: level_idc
  
  const profileIdc = sps[1];   // Skip NAL header (byte 0 = 0x67 for SPS)
  const constraints = sps[2];
  const levelIdc = sps[3];
  
  return `avc1.${profileIdc.toString(16).padStart(2, '0')}` +
         `${constraints.toString(16).padStart(2, '0')}` +
         `${levelIdc.toString(16).padStart(2, '0')}`;
}

// Common H.264 profiles:
// Baseline:        avc1.42001e (42 = 66, level 30)
// Main:            avc1.4d001f (4d = 77, level 31)  
// High:            avc1.64001f (64 = 100, level 31)
// High 4K:         avc1.640033 (64 = 100, level 51)
```

### SPS Resolution Parsing

```typescript
// Simplified SPS parsing for width/height
// Full SPS parsing requires Exp-Golomb decoding
function parseSPSResolution(sps: Uint8Array): { width: number; height: number } {
  // This requires a proper Exp-Golomb bitstream reader
  // Key fields: pic_width_in_mbs_minus1, pic_height_in_map_units_minus1
  // width = (pic_width_in_mbs_minus1 + 1) * 16
  // height = (pic_height_in_map_units_minus1 + 1) * 16
  //   (adjusted by frame_mbs_only_flag and cropping)
  
  // For a working implementation, use a proper H.264 SPS parser
  // or extract from the FFmpeg bridge server metadata
}
```

### H.264 NAL Unit Types

```typescript
const NAL_TYPES = {
  1: 'non-IDR slice',      // P/B frame (type: 'delta')
  5: 'IDR slice',          // Keyframe (type: 'key')
  6: 'SEI',                // Supplemental info (skip)
  7: 'SPS',                // Sequence Parameter Set (config)
  8: 'PPS',                // Picture Parameter Set (config)
  9: 'Access Unit Delimiter', // Frame boundary (skip)
};

// NAL type is in the lower 5 bits of the first byte after start code
function getNALType(nalUnit: Uint8Array): number {
  return nalUnit[0] & 0x1F;
}
```

### Annex B Start Code Detection

```typescript
// H.264 Annex B uses start codes to delimit NAL units:
// 4-byte: 0x00 0x00 0x00 0x01 (typically before SPS, PPS, first slice)
// 3-byte: 0x00 0x00 0x01 (typically before subsequent NAL units)

function* splitNALUnits(data: Uint8Array): Generator<Uint8Array> {
  let start = -1;
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        // 3-byte start code
        if (start >= 0) yield data.subarray(start, i);
        start = i + 3;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        // 4-byte start code
        if (start >= 0) yield data.subarray(start, i);
        start = i + 4;
        i++; // Skip extra byte
      }
    }
  }
  if (start >= 0) yield data.subarray(start);
}
```

## WebGPU Video Rendering

### importExternalTexture

```typescript
// Create a GPUExternalTexture from a VideoFrame
// This is ZERO-COPY when the frame is GPU-backed (hardware decode)
const externalTexture = device.importExternalTexture({
  source: videoFrame,  // VideoFrame from WebCodecs decoder
  // Optional: colorSpace (defaults to frame's color space)
});

// CRITICAL LIFETIME RULES:
// 1. GPUExternalTexture is valid ONLY until the current microtask completes
//    OR the VideoFrame is closed — whichever happens first
// 2. You MUST use it in the same synchronous render pass
// 3. You CANNOT cache it across frames
// 4. You MUST create a new bind group each frame

// Usage pattern:
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: sampler },
    { binding: 1, resource: externalTexture },
  ],
});

// Use in render pass immediately
renderPass.setBindGroup(0, bindGroup);
renderPass.draw(4);

// THEN close the frame
videoFrame.close();
```

### WGSL External Texture Sampling

```wgsl
// External textures use a special type and sampling function
@group(0) @binding(0) var mySampler: sampler;
@group(0) @binding(1) var myTexture: texture_external;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Must use textureSampleBaseClampToEdge (not textureSample)
  // This function handles YUV→RGB conversion automatically
  return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
}
```

### Bind Group Layout for External Texture

```typescript
// When using layout: 'auto', the pipeline automatically creates
// the correct bind group layout for texture_external.
// If you need explicit layout:
const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: 'filtering' },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      externalTexture: {},  // Special entry type for external textures
    },
    {
      binding: 2,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: 'uniform' },
    },
  ],
});
```

## Performance Measurement APIs

```typescript
// High-resolution timestamps
const t0 = performance.now(); // milliseconds, microsecond precision

// Memory (Chrome only)
if (performance.memory) {
  const heap = performance.memory.usedJSHeapSize; // bytes
  const heapTotal = performance.memory.totalJSHeapSize;
}

// Long tasks (jank detection)
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.warn(`Long task: ${entry.duration}ms`);
  }
});
observer.observe({ entryTypes: ['longtask'] });

// requestVideoFrameCallback (per-video metadata)
// Only available on HTMLVideoElement, not directly with WebCodecs
// For WebCodecs, use timestamps from VideoFrame:
//   frame.timestamp — presentation timestamp (microseconds)
//   frame.duration — frame duration (microseconds)
//   frame.codedWidth, frame.codedHeight — actual decoded dimensions

// WebGPU adapter info (for benchmark reports)
const adapter = await navigator.gpu.requestAdapter();
const info = await adapter.requestAdapterInfo();
// info.vendor, info.architecture, info.device, info.description
```

## Feature Detection

```typescript
async function checkBrowserCapabilities(): Promise<{
  webcodecs: boolean;
  webgpu: boolean;
  h264Hardware: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  
  // WebCodecs
  const webcodecs = typeof VideoDecoder !== 'undefined';
  if (!webcodecs) errors.push('WebCodecs not available');
  
  // WebGPU
  let webgpu = false;
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter({ 
      powerPreference: 'high-performance' 
    });
    webgpu = adapter !== null;
    if (!webgpu) errors.push('No WebGPU adapter found');
  } else {
    errors.push('WebGPU not available');
  }
  
  // H.264 hardware decode
  let h264Hardware = false;
  if (webcodecs) {
    const support = await VideoDecoder.isConfigSupported({
      codec: 'avc1.64001f',
      hardwareAcceleration: 'prefer-hardware',
    });
    h264Hardware = support.supported === true;
    if (!h264Hardware) errors.push('H.264 hardware decode not supported');
  }
  
  return { webcodecs, webgpu, h264Hardware, errors };
}
```
