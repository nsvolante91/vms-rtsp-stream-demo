# VMS Browser Prototype: WebCodecs + WebGPU Multi-Stream Video Surveillance

## 🎯 Project Mission

Build a **fully working browser-based Video Management System prototype** that demonstrates the maximum video streaming performance achievable in modern browsers today. This prototype uses **WebCodecs for hardware-accelerated decode** and **WebGPU for zero-copy GPU rendering** to display multiple simultaneous video streams in a surveillance-style grid layout, with a real-time performance dashboard proving what browsers can do.

**This is a technology demonstrator.** The goal is a working, impressive, measurable proof-of-concept — not a production VMS. Every architectural choice should prioritize: (1) actually working end-to-end, (2) demonstrating peak browser performance, (3) providing hard benchmark numbers.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        TEST ENVIRONMENT                         │
│                                                                 │
│  ┌──────────┐    RTSP     ┌───────────┐                        │
│  │  FFmpeg   │───────────▶│ MediaMTX  │                        │
│  │ (loops    │  (per      │ (RTSP     │                        │
│  │  test     │   stream)  │  server)  │                        │
│  │  videos)  │            │           │                        │
│  └──────────┘            └─────┬─────┘                        │
│                                │ RTSP                          │
│                          ┌─────▼─────┐                        │
│                          │  Bridge    │                        │
│                          │  Server    │                        │
│                          │ (Node.js)  │                        │
│                          └─────┬─────┘                        │
│                                │ WebSocket                     │
│                                │ (H.264 NAL units              │
│                                │  in Annex B format)           │
└────────────────────────────────┼────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────┐
│                     BROWSER CLIENT                              │
│                                                                 │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────────┐  │
│  │  WebSocket    │──▶│  WebCodecs     │──▶│  WebGPU         │  │
│  │  Receiver     │   │  VideoDecoder  │   │  Renderer       │  │
│  │              │   │  (HW accel)    │   │  (importExt-    │  │
│  │  • Depacket- │   │               │   │   ernalTexture)  │  │
│  │    izes NALs │   │  • H.264 HW   │   │                 │  │
│  │  • Builds    │   │    decode      │   │  • Zero-copy    │  │
│  │    chunks    │   │  • VideoFrame  │   │    GPU render   │  │
│  │  • Backpres- │   │    output      │   │  • YUV→RGB in   │  │
│  │    sure mgmt │   │  • Queue mgmt │   │    shader       │  │
│  └──────────────┘   └────────────────┘   │  • Grid layout  │  │
│                                           │    compositing  │  │
│  ┌──────────────────────────────────────┐ └─────────────────┘  │
│  │         Performance Dashboard         │                      │
│  │  • FPS per stream + aggregate         │                      │
│  │  • Decode time (ms)                   │                      │
│  │  • Render time (ms)                   │                      │
│  │  • Memory usage (JS heap + GPU est)   │                      │
│  │  • CPU usage (via performance API)    │                      │
│  │  • Frame drop count                   │                      │
│  │  • Decode queue depth                 │                      │
│  └──────────────────────────────────────┘                      │
│                                                                 │
│  ┌──────────────────────────────────────┐                      │
│  │            UI Controls                │                      │
│  │  • Grid layout: 1×1, 2×2, 3×3, 4×4  │                      │
│  │  • Click-to-zoom (full panel)         │                      │
│  │  • Add/remove streams                 │                      │
│  │  • Start/stop benchmark               │                      │
│  │  • Export performance report           │                      │
│  └──────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 Project Structure

```
vms-prototype/
├── .ralph/
│   ├── PROMPT.md              ← This file
│   ├── fix_plan.md            ← Task checklist
│   ├── AGENT.md               ← Build/run commands
│   └── specs/
│       ├── research_findings.md
│       ├── test_environment.md
│       └── webcodecs_api.md
├── .ralphrc                   ← Ralph configuration
├── CLAUDE.md                  ← Claude Code project context
│
├── docker/                    ← Test environment
│   ├── docker-compose.yml     ← MediaMTX + FFmpeg streams
│   ├── mediamtx.yml           ← MediaMTX config
│   └── Dockerfile.bridge      ← Bridge server container
│
├── bridge-server/             ← RTSP→WebSocket bridge (Node.js)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts           ← Entry point, WS server
│   │   ├── rtsp-client.ts     ← RTSP session management
│   │   ├── h264-parser.ts     ← NAL unit extraction & SPS/PPS parsing
│   │   └── stream-manager.ts  ← Manages multiple RTSP→WS bridges
│   └── tests/
│       └── h264-parser.test.ts
│
├── client/                    ← Browser application
│   ├── index.html             ← Entry point
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   ├── src/
│   │   ├── main.ts            ← App bootstrap
│   │   ├── stream/
│   │   │   ├── ws-receiver.ts      ← WebSocket frame receiver
│   │   │   ├── h264-demuxer.ts     ← Annex B → EncodedVideoChunk
│   │   │   ├── decoder.ts          ← WebCodecs VideoDecoder wrapper
│   │   │   └── stream-pipeline.ts  ← Orchestrates receive→decode→render
│   │   ├── render/
│   │   │   ├── gpu-renderer.ts     ← WebGPU setup + render loop
│   │   │   ├── grid-layout.ts      ← Viewport math for grid tiles
│   │   │   ├── shaders.wgsl        ← Vertex + fragment shaders
│   │   │   └── texture-manager.ts  ← importExternalTexture lifecycle
│   │   ├── perf/
│   │   │   ├── metrics-collector.ts ← Performance measurement
│   │   │   ├── dashboard.ts         ← Real-time stats overlay
│   │   │   └── benchmark-runner.ts  ← Automated benchmark suite
│   │   ├── ui/
│   │   │   ├── controls.ts          ← Grid layout, stream management
│   │   │   └── styles.css           ← Minimal UI styling
│   │   └── utils/
│   │       ├── ring-buffer.ts       ← Lock-free ring buffer for frames
│   │       └── logger.ts            ← Structured logging
│   └── tests/
│       ├── h264-demuxer.test.ts
│       └── grid-layout.test.ts
│
├── scripts/
│   ├── setup-test-env.sh      ← Downloads test videos + starts Docker
│   ├── generate-streams.sh    ← FFmpeg commands for N RTSP streams
│   └── run-benchmark.sh       ← Automated benchmark runner
│
├── docs/
│   ├── README.md              ← Setup + usage instructions
│   ├── ARCHITECTURE.md        ← Technical architecture doc
│   └── BENCHMARKS.md          ← How to read benchmark results
│
├── package.json               ← Root workspace
└── README.md                  ← Quick start
```

---

## 🔧 Component Specifications

### 1. Bridge Server (`bridge-server/`)

**Purpose:** Converts RTSP H.264 streams into WebSocket messages the browser can consume.

**Technology:** Node.js + TypeScript

**Dependencies:**
- `ws` — WebSocket server
- `rtsp-stream` or raw TCP RTSP implementation
- No heavy media libraries — we parse H.264 NAL units directly

**Protocol Design:**

WebSocket binary messages use a simple framing protocol:

```
Message Format:
┌─────────┬──────────┬───────────┬──────────┬─────────────┐
│ Version │ StreamID │ Timestamp │ Flags    │ Payload     │
│ 1 byte  │ 2 bytes  │ 8 bytes   │ 1 byte   │ Variable    │
│         │ uint16   │ uint64    │          │ H.264 NALUs │
│         │ BE       │ BE (μs)   │          │ Annex B     │
└─────────┴──────────┴───────────┴──────────┴─────────────┘

Flags byte:
  bit 0: keyframe (IDR)
  bit 1: contains SPS/PPS (codec config)
  bit 2: end of sequence
  bits 3-7: reserved

Special Messages (Version = 0xFF):
  StreamID=0: Server capabilities/config (JSON)
  StreamID=N + flag=config: Stream info (resolution, fps) as JSON
```

**Key Implementation Details:**

```typescript
// rtsp-client.ts — RTSP session management
class RTSPClient {
  // Connects to RTSP source, depacketizes RTP/H.264
  // Extracts NAL units from RTP payload (RFC 6184)
  // Handles: Single NAL, STAP-A, FU-A fragmentation
  // Emits: { nalUnit: Uint8Array, timestamp: bigint, isKeyframe: boolean }
  
  connect(url: string): Promise<void>;
  on(event: 'nalu', cb: (nalu: NALUnit) => void): void;
  on(event: 'sps', cb: (sps: Uint8Array) => void): void;
  on(event: 'pps', cb: (pps: Uint8Array) => void): void;
  close(): void;
}

// h264-parser.ts — NAL unit handling
// Parse SPS to extract: width, height, profile, level
// Build Annex B format: 0x00000001 + NALU
// Detect keyframes (NAL type 5 = IDR)
function parseSPS(sps: Uint8Array): { width: number; height: number; profile: number; level: number };
function isKeyframe(naluType: number): boolean;
function buildAnnexB(nalus: Uint8Array[]): Uint8Array;

// stream-manager.ts
class StreamManager {
  // Maps stream IDs to RTSP clients
  // Handles WebSocket client subscriptions
  // Sends SPS/PPS as first message on new subscription
  // Sends keyframe-first to allow immediate decode start
  
  addStream(id: number, rtspUrl: string): Promise<StreamInfo>;
  removeStream(id: number): void;
  handleClient(ws: WebSocket): void;
  getStreamInfo(id: number): StreamInfo;
}

// index.ts — Entry point
// WS server on configurable port (default 9000)
// REST API: GET /streams — list available streams
// REST API: POST /streams — add stream { rtspUrl }
// REST API: DELETE /streams/:id — remove stream
// WS: client sends JSON subscribe/unsubscribe messages
// WS: server sends binary frames per protocol above
```

**CRITICAL: RTSP Client Approach**

Use one of these approaches (in order of preference):
1. **FFmpeg child process** with `-f mpegts pipe:1` or `-f h264 pipe:1` output — most reliable
2. **Direct RTSP/RTP over TCP** — parse interleaved binary data from RTSP TCP connection
3. **npm `rtsp-stream`** or similar — if available and working

The FFmpeg approach is strongly recommended for reliability:
```typescript
// Spawn FFmpeg to read RTSP and output raw H.264 Annex B to stdout
const ffmpeg = spawn('ffmpeg', [
  '-rtsp_transport', 'tcp',
  '-i', rtspUrl,
  '-c:v', 'copy',        // No transcode — passthrough
  '-an',                  // No audio
  '-f', 'h264',           // Raw H.264 Annex B output
  '-'                     // Output to stdout
]);
// Parse stdout for NAL unit boundaries (0x00000001 or 0x000001)
```

---

### 2. Browser Client (`client/`)

**Technology:** TypeScript + Vite (vanilla — no React/Vue/Angular)

**Why vanilla?** Zero framework overhead. Every byte of CPU budget goes to video decode and render. The UI is simple enough that a framework adds only bloat.

**Dependencies (package.json):**
- `vite` — dev server + bundler
- `typescript` — type safety
- `vitest` — testing

No other runtime dependencies. All APIs are native browser.

#### 2.1 WebSocket Receiver (`ws-receiver.ts`)

```typescript
class WSReceiver {
  private ws: WebSocket;
  private onFrame: (frame: ReceivedFrame) => void;
  
  constructor(url: string, onFrame: FrameCallback) {
    // Binary WebSocket connection
    // Parse the binary protocol header
    // Route frames to correct stream pipeline by StreamID
    // Handle reconnection with exponential backoff
    // Track bytes received for bandwidth metrics
  }
  
  subscribe(streamId: number): void;
  unsubscribe(streamId: number): void;
  
  get bytesReceived(): number;
  get messagesPerSecond(): number;
}

interface ReceivedFrame {
  streamId: number;
  timestamp: bigint;
  isKeyframe: boolean;
  isConfig: boolean;     // Contains SPS/PPS
  data: Uint8Array;      // H.264 Annex B NAL units
}
```

#### 2.2 H.264 Demuxer (`h264-demuxer.ts`)

```typescript
class H264Demuxer {
  // Converts raw H.264 Annex B data into EncodedVideoChunk objects
  // Maintains SPS/PPS state for codec description
  // Generates avcC-style description from SPS+PPS for WebCodecs config
  
  // CRITICAL: WebCodecs VideoDecoder needs codec string like "avc1.64001f"
  // Extract profile_idc, constraint_set_flags, level_idc from SPS
  // Format: avc1.{profile_idc:02x}{constraint:02x}{level_idc:02x}
  
  processConfig(sps: Uint8Array, pps: Uint8Array): VideoDecoderConfig;
  
  createChunk(frame: ReceivedFrame): EncodedVideoChunk | null;
  // Returns null if no config received yet (waiting for SPS/PPS)
  // Sets type: 'key' for IDR frames, 'delta' for others
  // Uses frame.timestamp as microsecond presentation timestamp
}
```

#### 2.3 WebCodecs Decoder (`decoder.ts`)

```typescript
class VideoStreamDecoder {
  private decoder: VideoDecoder;
  private config: VideoDecoderConfig | null = null;
  
  constructor(
    private streamId: number,
    private onFrame: (frame: VideoFrame) => void,
    private onError: (error: Error) => void
  ) {
    // CRITICAL CONFIGURATION:
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // Pass frame to renderer
        // Frame MUST be closed by consumer — GPU memory leak otherwise!
        this.onFrame(frame);
      },
      error: (e: DOMException) => {
        this.onError(new Error(`Decoder error [stream ${streamId}]: ${e.message}`));
        // Attempt reset on error
        this.reset();
      }
    });
  }
  
  configure(config: VideoDecoderConfig): void {
    // config.codec = "avc1.XXYYZZ" from SPS parsing
    // config.hardwareAcceleration = "prefer-hardware"
    // config.optimizeForLatency = true  // CRITICAL for live streaming
    this.decoder.configure(config);
  }
  
  decode(chunk: EncodedVideoChunk): void {
    // BACKPRESSURE: Check decodeQueueSize before feeding
    // If decodeQueueSize > 3, drop non-keyframe chunks
    // Log dropped frames for metrics
    if (this.decoder.decodeQueueSize > 3 && chunk.type !== 'key') {
      this.metrics.droppedFrames++;
      return;
    }
    this.decoder.decode(chunk);
  }
  
  async reset(): Promise<void> {
    // Flush, reset, reconfigure
    // Wait for keyframe before resuming decode
  }
  
  close(): void {
    this.decoder.close();
  }
  
  get queueSize(): number {
    return this.decoder.decodeQueueSize;
  }
}
```

#### 2.4 WebGPU Renderer (`gpu-renderer.ts`)

```typescript
class GPURenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  
  // Per-stream state
  private streamBindGroups: Map<number, GPUBindGroup> = new Map();
  private streamViewports: Map<number, Viewport> = new Map();
  
  async init(canvas: HTMLCanvasElement): Promise<void> {
    // 1. Request adapter with powerPreference: 'high-performance'
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    
    // 2. Request device
    this.device = await adapter.requestDevice();
    
    // 3. Configure canvas context
    this.context = canvas.getContext('webgpu');
    this.context.configure({
      device: this.device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'opaque',
    });
    
    // 4. Create render pipeline with external texture sampler
    // See shaders.wgsl for shader source
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({ code: vertexShader }),
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: this.device.createShaderModule({ code: fragmentShader }),
        entryPoint: 'fragmentMain',
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32' },
    });
    
    // 5. Create sampler for video textures
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }
  
  renderFrame(streamId: number, videoFrame: VideoFrame): void {
    // CRITICAL: importExternalTexture creates a GPUExternalTexture
    // This is ZERO-COPY when the VideoFrame is GPU-backed
    // The texture is ONLY valid for this frame — must be used immediately
    
    const externalTexture = this.device.importExternalTexture({
      source: videoFrame,
    });
    
    // Create bind group with external texture + sampler
    // Bind group includes viewport uniforms for grid positioning
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.getViewportUniform(streamId) } },
      ],
    });
    
    // Draw — one quad per stream in the grid
    // After draw, close the VideoFrame to release GPU memory
    // This MUST happen every frame or GPU memory will exhaust
    videoFrame.close();
  }
  
  renderAll(frames: Map<number, VideoFrame>): void {
    // Called once per requestAnimationFrame
    // Renders all stream quads in a single command encoder
    const commandEncoder = this.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
      }],
    });
    
    renderPass.setPipeline(this.pipeline);
    
    for (const [streamId, videoFrame] of frames) {
      const viewport = this.streamViewports.get(streamId);
      if (!viewport) continue;
      
      const externalTexture = this.device.importExternalTexture({
        source: videoFrame,
      });
      
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: externalTexture },
          { binding: 2, resource: { buffer: viewport.uniformBuffer } },
        ],
      });
      
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(4); // Triangle strip quad
      
      videoFrame.close(); // CRITICAL: release GPU memory
    }
    
    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }
  
  updateLayout(layout: GridLayout): void {
    // Recalculate viewport uniforms for new grid configuration
    // Each stream gets: { offsetX, offsetY, scaleX, scaleY }
  }
}
```

#### 2.5 WGSL Shaders (`shaders.wgsl`)

```wgsl
// Vertex shader — generates a full-screen quad positioned by viewport uniforms
struct ViewportUniforms {
  offset: vec2<f32>,   // Grid position (0..1 space)
  scale: vec2<f32>,    // Grid tile size (0..1 space)
};

@group(0) @binding(2) var<uniform> viewport: ViewportUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Triangle strip: 4 vertices for a quad
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
  
  // Apply viewport transform: map quad to grid tile position
  var p = pos[vertexIndex];
  p = p * viewport.scale + viewport.offset;
  
  var output: VertexOutput;
  output.position = vec4<f32>(p, 0.0, 1.0);
  output.texCoord = uv[vertexIndex];
  return output;
}

// Fragment shader — samples external video texture
// importExternalTexture handles YUV→RGB conversion automatically
@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var texVideo: texture_external;

@fragment
fn fragmentMain(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSampleBaseClampToEdge(texVideo, texSampler, texCoord);
}
```

#### 2.6 Grid Layout (`grid-layout.ts`)

```typescript
interface Viewport {
  streamId: number;
  x: number;      // 0..1 normalized
  y: number;      // 0..1 normalized
  width: number;  // 0..1 normalized
  height: number; // 0..1 normalized
}

class GridLayout {
  // Generates viewport positions for N streams in a grid
  // Supports: 1×1, 2×2, 3×3, 4×4, and custom layouts
  // Click-to-zoom: selected stream fills 75% of canvas,
  //   remaining streams stack in sidebar
  
  static calculate(streamIds: number[], columns: number): Viewport[];
  
  static calculateWithFocus(
    streamIds: number[], 
    focusId: number, 
    columns: number
  ): Viewport[];
  // Focus stream gets 75% width, remaining in sidebar column
}
```

#### 2.7 Performance Dashboard (`metrics-collector.ts` + `dashboard.ts`)

```typescript
interface StreamMetrics {
  streamId: number;
  fps: number;                    // Measured output FPS
  decodeTimeMs: number;           // Average decode latency (ms)
  renderTimeMs: number;           // Average render latency (ms)
  frameDropCount: number;         // Frames dropped due to backpressure
  decodeQueueSize: number;        // Current decode queue depth
  bytesReceived: number;          // Total bytes from WebSocket
  bitrateKbps: number;            // Current receive bitrate
}

interface GlobalMetrics {
  totalFps: number;               // Sum of all stream FPS
  jsHeapUsedMB: number;           // performance.memory.usedJSHeapSize
  jsHeapTotalMB: number;          // performance.memory.totalJSHeapSize
  cpuFrameTimeMs: number;         // requestAnimationFrame budget usage
  gpuFrameTimeMs: number;         // Estimated from timestamp queries if available
  activeStreams: number;
  totalBandwidthMbps: number;
  longestFrameMs: number;         // Worst-case frame time (jank detector)
}

class MetricsCollector {
  // Uses performance.now() for high-resolution timing
  // Samples at 1Hz for dashboard, captures all for export
  // Records per-frame decode start/end timestamps
  // Uses PerformanceObserver for long task detection
  
  recordDecodeStart(streamId: number, timestamp: number): void;
  recordDecodeEnd(streamId: number, timestamp: number): void;
  recordRender(streamId: number, timestamp: number): void;
  recordFrameDrop(streamId: number): void;
  
  getStreamMetrics(streamId: number): StreamMetrics;
  getGlobalMetrics(): GlobalMetrics;
  
  exportCSV(): string;    // Full benchmark data export
  exportJSON(): string;   // Structured benchmark report
}

class Dashboard {
  // DOM overlay in corner of canvas
  // Updates at 1Hz to avoid layout thrashing
  // Shows: FPS (per-stream + total), decode time, memory, CPU frame budget
  // Color-codes: green (>25fps), yellow (15-25fps), red (<15fps)
  // Toggle visibility with 'D' key
  
  constructor(container: HTMLElement, collector: MetricsCollector);
  update(): void;
  toggle(): void;
}
```

#### 2.8 Benchmark Runner (`benchmark-runner.ts`)

```typescript
class BenchmarkRunner {
  // Automated benchmark that progressively adds streams
  // Measures stable performance at each level
  // Produces a report showing max sustainable stream count
  
  async run(config: BenchmarkConfig): Promise<BenchmarkReport> {
    // 1. Start with 1 stream, measure for 10 seconds
    // 2. Add streams one at a time (or 2×2, 3×3, 4×4 grid steps)
    // 3. At each level, wait 5s for stabilization, then measure 10s
    // 4. Record: avg FPS, min FPS, 95th percentile frame time,
    //    decode queue depth, dropped frames, memory usage
    // 5. Stop when avg FPS drops below threshold (e.g., 20fps)
    //    or when all requested streams are active
    // 6. Generate report with CSV + summary
  }
}

interface BenchmarkConfig {
  maxStreams: number;      // Maximum streams to test (default: 16)
  stepSize: number;        // Streams to add per step (default: 1)
  stabilizeMs: number;     // Wait time after adding streams (default: 5000)
  measureMs: number;       // Measurement window per step (default: 10000)
  fpsThreshold: number;    // Stop if avg FPS drops below (default: 20)
  resolution: '480p' | '720p' | '1080p' | '4k';
}

interface BenchmarkReport {
  timestamp: string;
  userAgent: string;
  gpuInfo: string;          // From WebGPU adapter info
  results: BenchmarkStep[];
  maxSustainableStreams: number;
  summary: string;
}
```

#### 2.9 Stream Pipeline Orchestrator (`stream-pipeline.ts`)

```typescript
class StreamPipeline {
  // Orchestrates the full pipeline for a single stream:
  // WSReceiver → H264Demuxer → VideoStreamDecoder → frame queue → GPURenderer
  
  // Manages lifecycle: start, pause, resume, stop
  // Handles error recovery: decoder reset, reconnection
  // Implements frame dropping strategy when overloaded
  
  private receiver: WSReceiver;
  private demuxer: H264Demuxer;
  private decoder: VideoStreamDecoder;
  private latestFrame: VideoFrame | null = null;
  
  constructor(
    streamId: number,
    wsUrl: string,
    metrics: MetricsCollector
  );
  
  start(): Promise<void>;
  stop(): void;
  
  // Called by render loop — returns most recent decoded frame
  // Returns null if no new frame available
  consumeFrame(): VideoFrame | null {
    const frame = this.latestFrame;
    this.latestFrame = null;
    return frame;
    // NOTE: caller is responsible for frame.close()
  }
}

// Main application controller
class VMSApp {
  private pipelines: Map<number, StreamPipeline> = new Map();
  private renderer: GPURenderer;
  private metrics: MetricsCollector;
  private dashboard: Dashboard;
  
  async init(): Promise<void>;
  
  async addStream(streamId: number): Promise<void>;
  removeStream(streamId: number): void;
  
  setLayout(columns: number): void;
  setFocus(streamId: number | null): void;
  
  // Main render loop
  private renderLoop = (): void => {
    const frames = new Map<number, VideoFrame>();
    
    for (const [id, pipeline] of this.pipelines) {
      const frame = pipeline.consumeFrame();
      if (frame) frames.set(id, frame);
    }
    
    if (frames.size > 0) {
      this.renderer.renderAll(frames);
      // frames are closed inside renderAll
    }
    
    this.metrics.recordRenderCycle();
    requestAnimationFrame(this.renderLoop);
  };
  
  async startBenchmark(): Promise<BenchmarkReport>;
  exportMetrics(): void;
}
```

---

## 🧪 Test Environment

### Test Video Sources

Download test videos and loop them as simulated camera feeds. The setup script handles this automatically.

**Required test videos (download in setup script):**
- `Big Buck Bunny` — H.264, 1080p, 30fps (standard test content)
- `Tears of Steel` — H.264, 1080p, 24fps (different motion characteristics)
- `Sintel` — H.264, various resolutions

**URLs:**
```
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4
http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4
```

**Generate additional resolution variants with FFmpeg:**
```bash
# 4K upscale for testing (from 1080p source)
ffmpeg -i BigBuckBunny.mp4 -vf scale=3840:2160 -c:v libx264 -preset fast -crf 23 bbb_4k.mp4

# 720p downscale
ffmpeg -i BigBuckBunny.mp4 -vf scale=1280:720 -c:v libx264 -preset fast -crf 23 bbb_720p.mp4

# 480p downscale  
ffmpeg -i BigBuckBunny.mp4 -vf scale=854:480 -c:v libx264 -preset fast -crf 23 bbb_480p.mp4
```

### Docker Compose Setup

See `specs/test_environment.md` for the complete Docker Compose configuration.

**The setup creates N simulated camera streams:**
- Each stream: FFmpeg reads a video file, loops infinitely, publishes to MediaMTX via RTSP
- MediaMTX acts as the RTSP server, accessible at `rtsp://localhost:8554/stream{N}`
- Bridge server connects to each MediaMTX stream, serves WebSocket at `ws://localhost:9000`

---

## 🎯 Exit Criteria

Ralph should signal EXIT_SIGNAL: true when ALL of the following are met:

### Must Have (ALL required):
- [ ] `docker compose up` starts MediaMTX + at least 4 simulated RTSP streams
- [ ] Bridge server starts, connects to RTSP streams, serves WebSocket
- [ ] Browser client loads, connects to bridge server via WebSocket
- [ ] At least 1 video stream decodes via WebCodecs and renders via WebGPU
- [ ] Grid layout works for 1×1, 2×2, 3×3, 4×4 configurations
- [ ] Performance dashboard shows live FPS, decode time, memory metrics
- [ ] Click a stream tile to zoom (focus mode)
- [ ] Benchmark runner completes and produces a report
- [ ] `README.md` has working quickstart instructions (copy-paste to run)
- [ ] All TypeScript compiles without errors
- [ ] Basic tests pass (`vitest run`)

### Nice to Have (complete if time allows):
- [ ] 16 simultaneous streams at 1080p with >20fps each
- [ ] Graceful degradation when overloaded (drops frames, doesn't crash)
- [ ] CSV/JSON benchmark export
- [ ] WebGPU fallback to Canvas2D if WebGPU unavailable
- [ ] Stream reconnection on disconnect

### Explicitly Out of Scope:
- Authentication/authorization
- Recording/playback controls
- Audio
- HEVC/VP9/AV1 codec support (H.264 only for prototype)
- Mobile browser support
- Production error handling
- PTZ camera controls

---

## ⚠️ Critical Implementation Notes

### VideoFrame Lifecycle (MEMORY LEAK PREVENTION)
```
EVERY VideoFrame MUST be closed after use.
The WebCodecs decoder outputs GPU-backed VideoFrame objects.
If you don't call frame.close(), GPU memory accumulates until the tab crashes.
At 30fps × 16 streams = 480 frames/second, leaks are catastrophic within seconds.

Pattern:
  decoder.output → store in latestFrame
  renderLoop → consume frame → importExternalTexture → draw → frame.close()
  
If a new frame arrives before the old one is consumed:
  close the old frame immediately, replace with new one.
```

### WebGPU importExternalTexture Lifetime
```
GPUExternalTexture from importExternalTexture() is valid ONLY until:
  - The current task completes (microtask boundary)
  - OR the VideoFrame is closed
  
This means: import the texture and use it in the SAME synchronous render pass.
You CANNOT cache GPUExternalTexture across frames.
Each frame requires a new import + new bind group.
```

### Decode Queue Backpressure
```
VideoDecoder.decodeQueueSize tells you how many frames are queued.
If this grows beyond ~3, the decoder is falling behind.

Strategy:
  if (decoder.decodeQueueSize > 3 && !chunk.isKeyframe) {
    drop the frame
    increment dropped frame counter
  }
  
Never drop keyframes — they're needed for future delta frames.
After dropping, wait for next keyframe to resync if quality drops.
```

### H.264 Annex B → WebCodecs Configuration
```
WebCodecs needs a codec string like "avc1.64001f" derived from SPS.
Parse the SPS NAL unit (type 7):
  byte 1 = profile_idc (e.g., 0x64 = High profile)
  byte 2 = constraint_set flags
  byte 3 = level_idc (e.g., 0x1f = Level 3.1)
  
Codec string = `avc1.${profile_idc hex}${constraint hex}${level_idc hex}`

The VideoDecoder.configure() call needs:
  {
    codec: "avc1.64001f",
    codedWidth: <from SPS>,
    codedHeight: <from SPS>,
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  }
```

### Browser Compatibility Check
```
On page load, check:
  1. navigator.gpu exists (WebGPU available)
  2. VideoDecoder exists (WebCodecs available)
  3. await navigator.gpu.requestAdapter() succeeds
  4. await VideoDecoder.isConfigSupported({ codec: 'avc1.42001e' }) 

If any check fails, show a clear error message with browser requirements.
Minimum: Chrome 113+ or Edge 113+ (Safari 26+ for WebGPU but limited WebCodecs)
```

---

## 🔄 Development Phases

**Phase 1: Foundation (bridge server + single stream decode)**
Get one stream flowing: Docker → MediaMTX → FFmpeg → RTSP → Bridge → WebSocket → Browser → WebCodecs decode → Canvas2D render (before WebGPU)

**Phase 2: WebGPU rendering**
Replace Canvas2D with WebGPU. Implement `importExternalTexture`, shaders, single-stream GPU render.

**Phase 3: Multi-stream grid**
Add grid layout, multiple decoder instances, unified render loop. Test with 4 streams.

**Phase 4: Performance dashboard + benchmark**
Implement metrics collection, dashboard overlay, benchmark runner. Scale to 9-16 streams.

**Phase 5: Polish + documentation**
Click-to-zoom, UI controls, README, architecture docs, benchmark report template.

---

*Claude Code should implement each phase incrementally, running tests after each phase, and signal EXIT_SIGNAL: true only when all "Must Have" exit criteria are met.*
