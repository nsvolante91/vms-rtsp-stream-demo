# VMS Browser Prototype

**Multi-stream H.264 video surveillance in the browser using WebCodecs + Canvas2D**

A technology demonstrator showing that modern browsers can hardware-decode and render multiple simultaneous H.264 video streams with near-native performance. Built with zero runtime dependencies in the browser client — pure browser APIs.

## What It Does

- Displays 1–16+ simultaneous video streams in a configurable CSS grid layout
- Hardware-accelerated H.264 decode via **WebCodecs** `VideoDecoder`
- Per-stream Canvas2D rendering — each stream has its own `<canvas>` element
- Real-time performance dashboard (FPS, decode latency, memory, frame drops)
- Automated benchmark that progressively adds streams and measures limits
- Click-to-zoom on any stream tile
- Auto-recovery from decoder errors (reconnects on next keyframe)

## Architecture

```
FFmpeg loops ──RTSP──▶ MediaMTX ──RTSP──▶ Bridge Server ──WebSocket──▶ Browser
  (test videos)        (RTSP server)     (Node.js)                    (WebCodecs + Canvas2D)
```

1. **Test Environment** (Docker): MediaMTX RTSP server + FFmpeg looping test videos as simulated cameras
2. **Bridge Server** (Node.js/TypeScript): Reads RTSP streams via FFmpeg, extracts H.264 NAL units, accumulates them into complete access units, and serves them over WebSocket with a binary protocol
3. **Browser Client** (TypeScript/Vite): Receives H.264 over WebSocket, demuxes Annex B into `EncodedVideoChunk`s, decodes via WebCodecs `VideoDecoder` (hardware-accelerated), renders each stream to its own canvas via `ctx.drawImage(VideoFrame)`, displays in a CSS grid with real-time performance metrics

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 20+ | Bridge server + build tooling |
| **Docker** + Docker Compose | Any recent | Runs MediaMTX RTSP server |
| **FFmpeg** | 5+ (on host) | Generates simulated camera streams |
| **Chrome** or **Edge** | 113+ | WebCodecs `VideoDecoder` support |

## Quick Start

You need **4 terminal windows** (or use background processes).

### 1. Clone and install

```bash
git clone https://github.com/nsvolante91/vms-rtsp-stream-demo.git
cd vms-rtsp-stream-demo
npm install
```

### 2. Set up test environment

Downloads sample videos and starts the MediaMTX RTSP server in Docker:

```bash
./scripts/setup-test-env.sh
```

This will:
- Download Big Buck Bunny and Tears of Steel sample videos to `test-videos/`
- Generate 720p and 480p resolution variants
- Start the MediaMTX Docker container (RTSP on port 8554)

### 3. Start simulated camera streams

```bash
./scripts/generate-streams.sh 4
```

This spawns 4 FFmpeg processes, each looping a test video and publishing to MediaMTX as an RTSP stream (`stream1` through `stream4`). You can pass a different number for more/fewer streams.

Verify a stream is working:
```bash
ffprobe -rtsp_transport tcp rtsp://localhost:8554/stream1
```

### 4. Start the bridge server

```bash
npm run bridge
```

The bridge server connects to the RTSP streams, extracts H.264 NAL units, and serves them over WebSocket on `ws://localhost:9000`. It also exposes `http://localhost:9000/streams` for the client to discover available streams.

### 5. Start the browser client

```bash
npm run dev
```

Open **Chrome** at `http://localhost:5173`. The client auto-detects available streams and begins playing up to 4 streams in a 2x2 grid.

## Usage

- **Grid layout**: Click 1x1, 2x2, 3x3, or 4x4 buttons to change grid columns
- **Add/Remove streams**: Use the + Stream / - Stream buttons
- **Zoom**: Click any stream tile to focus it full-screen; click again to return to grid
- **Dashboard**: Toggle the performance overlay via the Dashboard button
- **Benchmark**: Click "Run Benchmark" to auto-test stream scaling limits
- **Export**: Click "Export Metrics" to download performance data as JSON

## Stopping Everything

```bash
# Stop simulated streams
pkill -f 'ffmpeg.*rtsp.*stream'

# Stop Docker (MediaMTX)
docker compose -f docker/docker-compose.yml down

# Stop bridge server and client dev server
# Ctrl+C in their respective terminals
```

## Project Layout

```
├── bridge-server/          # Node.js WebSocket bridge (RTSP → WS)
│   ├── src/
│   │   ├── server.ts           # HTTP + WebSocket server
│   │   ├── stream-manager.ts   # RTSP stream lifecycle + access unit packaging
│   │   ├── rtsp-client.ts      # FFmpeg subprocess for RTSP reading
│   │   └── h264-parser.ts      # NAL unit parsing, SPS decode, codec string
│   └── tests/
├── client/                 # Vite TypeScript browser app (zero runtime deps)
│   ├── src/
│   │   ├── main.ts             # App controller, CSS grid management
│   │   ├── stream/
│   │   │   ├── ws-receiver.ts      # WebSocket client + binary protocol parser
│   │   │   ├── stream-pipeline.ts  # Per-stream decode pipeline
│   │   │   ├── h264-demuxer.ts     # Annex B → EncodedVideoChunk
│   │   │   └── decoder.ts         # VideoDecoder wrapper with backpressure + auto-recovery
│   │   ├── render/
│   │   │   ├── stream-tile.ts     # Per-stream canvas + label overlay (Canvas2D)
│   │   │   ├── gpu-renderer.ts    # WebGPU renderer (partial, not yet active)
│   │   │   └── shaders.wgsl       # WGSL vertex/fragment shaders for WebGPU
│   │   ├── perf/
│   │   │   ├── metrics-collector.ts
│   │   │   ├── dashboard.ts
│   │   │   └── benchmark-runner.ts
│   │   └── ui/
│   │       ├── controls.ts
│   │       └── styles.css
│   └── tests/
├── docker/                 # Docker Compose + MediaMTX config
│   ├── docker-compose.yml
│   └── mediamtx.yml
├── scripts/
│   ├── setup-test-env.sh       # One-time setup (download videos, start Docker)
│   └── generate-streams.sh     # Spawn FFmpeg RTSP stream publishers
├── CLAUDE.md               # AI assistant context
└── package.json            # Monorepo root (npm workspaces)
```

## Testing

```bash
npm test                 # All tests (bridge + client)
npm run test:bridge      # Bridge server tests only
npm run test:client      # Client tests only
npm run typecheck        # TypeScript type checking (both packages)
```

## Key Technical Details

- **Binary WebSocket protocol**: 12-byte header (version + streamId + timestamp + flags) followed by H.264 Annex B payload. Config frames carry SPS/PPS for decoder initialization; video frames carry complete access units.
- **Access unit packaging**: The bridge server accumulates H.264 NAL units into complete access units (all slices for one picture) before sending, using `first_mb_in_slice` detection for slice boundary detection.
- **Decoder auto-recovery**: If the WebCodecs `VideoDecoder` hits an error, it automatically resets, reconfigures, and resumes decoding on the next keyframe.
- **Backpressure**: Non-keyframes are dropped when `decodeQueueSize > 3` to prevent queue buildup. Keyframes are never dropped.
- **VideoFrame lifecycle**: Every `VideoFrame` from the decoder is closed after rendering via `frame.close()` to prevent GPU memory leaks.

## Roadmap: WebGPU Rendering

The current renderer uses Canvas2D (`ctx.drawImage(VideoFrame)`) per stream tile. This works well and proves the decode pipeline, but leaves performance on the table. The next major step is **WebGPU rendering** using `importExternalTexture` for zero-copy GPU compositing.

A partial WebGPU implementation already exists in `client/src/render/gpu-renderer.ts` and `client/src/render/shaders.wgsl` from an earlier iteration. It uses a single shared canvas with viewport uniforms. The plan below adapts it to the current per-tile architecture.

### Why WebGPU

| | Canvas2D (current) | WebGPU (planned) |
|---|---|---|
| **Frame transfer** | CPU-side drawImage copies pixels | `importExternalTexture` — zero-copy, frame stays on GPU |
| **Color conversion** | Browser does YUV→RGB on CPU | GPU does YUV→RGB via external texture sampling |
| **Scaling** | CPU bilinear interpolation | GPU bilinear via sampler, runs in parallel |
| **Compositing** | One drawImage call per tile, sequential | Single render pass draws all tiles with GPU parallelism |
| **Target benefit** | Baseline working | ~2-3x more streams before hitting limits |

### Implementation Plan

#### Phase 1: Per-tile WebGPU renderer

Replace Canvas2D in `StreamTile` with a WebGPU canvas context. Each tile gets its own `GPUCanvasContext` but shares a single `GPUDevice`.

**Files to change:**
- `client/src/render/stream-tile.ts` — Switch canvas context from `2d` to `webgpu`, add `importExternalTexture` + single-quad render pass in `drawFrame()`
- `client/src/render/gpu-context.ts` — **New.** Singleton that initializes `GPUAdapter` + `GPUDevice` once, shared across all tiles. Holds the `GPURenderPipeline`, `GPUSampler`, and `GPUShaderModule`.
- `client/src/main.ts` — Initialize GPU context at startup, pass to each `StreamTile`
- `client/src/render/shaders.wgsl` — Simplify: remove viewport uniforms (each canvas is full-quad), keep `texture_external` sampling

**Key constraints:**
- `importExternalTexture` returns a `GPUExternalTexture` that expires at the end of the current microtask. Must call `importExternalTexture` and submit the command buffer in the same synchronous block — no `await` between them.
- `VideoFrame.close()` must still be called after the command buffer is submitted (not before, or the external texture is invalidated).
- Feature detection: fall back to Canvas2D if `navigator.gpu` is unavailable.

**Per-tile render flow:**
```
decoder callback fires with VideoFrame
  → tile.drawFrame(frame)
    → device.importExternalTexture({ source: frame })
    → device.createBindGroup(externalTexture + sampler)
    → commandEncoder.beginRenderPass(canvasTextureView)
    → renderPass.draw(4)  // fullscreen triangle strip
    → device.queue.submit([commandEncoder.finish()])
    → frame.close()
```

#### Phase 2: Single-canvas compositor (optional, for 16+ streams)

For very high stream counts, per-tile canvases create overhead from multiple `GPUCanvasContext`s. Switch to a single `<canvas>` that composites all streams in one render pass using viewport uniforms.

**Files to change:**
- `client/src/render/gpu-compositor.ts` — **New.** Single canvas, one render pass, loops over streams drawing textured quads at viewport positions (reuse existing `gpu-renderer.ts` pattern)
- `client/src/render/shaders.wgsl` — Restore viewport uniform (`offset` + `scale`) for multi-tile rendering
- `client/src/main.ts` — Replace CSS grid + per-tile rendering with single canvas + compositor
- `client/src/ui/styles.css` — Overlay stream labels as absolutely-positioned divs on top of the single canvas

**Tradeoffs vs Phase 1:**
- Pro: single render pass for all streams, less context switching
- Pro: better scaling past 16 streams
- Con: loses CSS grid flexibility (must calculate viewport positions manually)
- Con: single canvas resize affects all streams
- Con: label overlays require separate DOM positioning logic

#### Phase 3: Advanced GPU features

- **Multi-render-target**: Render different streams to different texture views in one pass
- **Compute shader post-processing**: Deinterlacing, edge enhancement, or motion detection on the GPU
- **HDR / wide-gamut**: Use `rgba16float` canvas format for HDR surveillance cameras
- **WebCodecs `VideoFrame` → `GPUTexture` via `copyExternalImageToTexture`**: Alternative to `importExternalTexture` when you need the frame to persist across microtasks (costs a copy but allows deferred rendering)

### Browser Support

WebGPU `importExternalTexture(VideoFrame)` requires:
- Chrome 113+ (stable since May 2023)
- Edge 113+
- Firefox: not yet supported (behind flag)
- Safari: WebGPU supported but `importExternalTexture` with VideoFrame not yet available

The implementation should always include a Canvas2D fallback path for unsupported browsers.

## License

MIT
