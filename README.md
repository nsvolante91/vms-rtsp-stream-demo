# VMS Browser Prototype

**Multi-stream H.264 video surveillance in the browser using WebCodecs + WebGPU + WebTransport**

A technology demonstrator showing that modern browsers can hardware-decode, GPU-upscale, and render multiple simultaneous H.264 video streams with near-native performance. Built with zero runtime dependencies in the browser client — pure browser APIs.

## What It Does

- Displays 1–16+ simultaneous video streams in a configurable CSS grid layout
- Hardware-accelerated H.264 decode via **WebCodecs** `VideoDecoder`
- Zero-copy GPU rendering via **WebGPU** `importExternalTexture` — frames stay on the GPU
- Low-latency streaming via **WebTransport** (HTTP/3 QUIC) — per-stream flow control, no head-of-line blocking
- Dedicated **Web Worker** pipeline — decode + render off the main thread
- 9 GPU upscaling/super-resolution modes (bilinear, Lanczos, FSR, DLSS-style, spectral, temporal, VQSR, generative, compute)
- Side-by-side comparison mode (upscaled vs. original)
- Per-stream overlay with real-time metrics (FPS, bitrate, decode latency, resolution)
- Click-to-zoom with GPU-accelerated crop and pan
- Auto-recovery from decoder errors (reconnects on next keyframe)
- WebSocket fallback when WebTransport is unavailable

## Architecture

### System Overview & Data Flow

<img src="docs/architecture-overview.svg" alt="System architecture: Docker test environment → Bridge Server → Browser Client" />

1. **Test Environment** (Docker): FFmpeg loops test videos and publishes them as RTSP streams to MediaMTX on port 8554.
2. **Bridge Server** (Node.js/TypeScript): RTSPClient spawns FFmpeg to read RTSP streams, H264Parser extracts NAL units + SPS metadata, StreamManager multiplexes frames to subscribers. Serves video over **WebTransport** (HTTP/3 QUIC, port 9001) with a 12-byte binary header protocol, plus a **REST API** (HTTP/1.1, port 9000) for stream management and TLS cert-hash retrieval. **WebSocket** fallback on `/ws` when QUIC is unavailable. Self-signed ECDSA P-256 certificate generated at startup.
3. **Browser Client** (TypeScript/Vite): Dedicated Web Worker owns the entire media pipeline — transport, decode, and render all happen off the main thread. Main thread handles only DOM, CSS Grid layout, and UI controls.

### Browser Client Pipeline

<img src="docs/architecture-browser.svg" alt="Browser client pipeline: Main Thread vs Web Worker architecture" />

- **Main Thread**: VMSApp orchestrates device detection, CSS Grid layout (1×1 to 4×4), StreamTile[] (canvas + overlay per stream), Controls, MetricsCollector, Dashboard, and BenchmarkRunner.
- **Web Worker**: WTReceiver (BYOB reader, auto-reconnect) → StreamPipeline → H264Demuxer (Annex B → EncodedVideoChunk) → VideoDecoder (WebCodecs HW accel, backpressure: drop B-frames at queue ≥3, non-keyframes at ≥4) → rAF-gated batch render via OffscreenRenderer.
  - **WebGPU path**: `importExternalTexture` (zero-copy, valid until microtask end) → upscale shaders (10 modes: off, CAS, FSR, Anime4K, Lanczos, TSR, Spectral, VQSR, Generative, DLSS) → `queue.submit()` → `frame.close()`.
  - **Canvas2D fallback**: `drawImage(VideoFrame)` with letterbox/pillarbox → `frame.close()`.
- **postMessage** carries commands (init, addStream, resize, setUpscale, setZoom) main→worker and events (connected, error, metrics at 1 Hz) worker→main.

### Mobile vs Desktop Configuration

| Setting | Mobile | Desktop |
|---------|--------|---------|
| Max streams | 4 | 16 |
| GPU power preference | `default` | `high-performance` |
| Max DPR (device pixel ratio) | 2 | 3 |
| Available upscale modes | off, CAS, FSR, Anime4K, Lanczos | All 10 modes |
| Zoom interaction | Pinch-to-zoom, one-finger pan, double-tap | Drag rectangle, double-click reset |
| Transport fallback | WebSocket (if QUIC unavailable) | WebSocket (if QUIC unavailable) |
| Render fallback | Canvas2D (if WebGPU blocklisted) | Canvas2D (if WebGPU unavailable) |

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 20+ | Bridge server + build tooling |
| **Docker** + Docker Compose | Any recent | Runs MediaMTX RTSP server |
| **FFmpeg** | 5+ (on host) | Generates simulated camera streams |
| **Chrome** or **Edge** | 114+ | WebTransport + WebGPU + WebCodecs |

## Quick Start

### 1. Install

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

### 3. Start simulated camera streams

```bash
./scripts/generate-streams.sh 4
```

Spawns 4 FFmpeg processes, each looping a test video and publishing to MediaMTX as RTSP (`stream1`–`stream4`).

Verify a stream is working:
```bash
ffprobe -rtsp_transport tcp rtsp://localhost:8554/stream1
```

### 4. Start the bridge server

**Local mode** (MediaMTX test streams on localhost):
```bash
npm run bridge
# or equivalently:
npm run bridge:local
```

The bridge server auto-discovers streams at `rtsp://localhost:8554/stream1..N` and serves them over WebTransport on port 9001 with a REST API on port 9000. The TLS certificate hash is available at `http://localhost:9000/cert-hash` — the client fetches it automatically.

**External camera mode** (real IP camera or remote RTSP server):
```bash
RTSP_BASE_URL=rtsp://user:pass@camera-ip:554/path npm run bridge:external
```

Set `RTSP_BASE_URL` to any RTSP URL. The bridge will treat it as a single direct stream.

### 5. Start the browser client

```bash
npm run dev
```

Open **Chrome** at `https://localhost:5173` (note: HTTPS). Accept the self-signed certificate warning. The client auto-fetches the certificate hash, connects via WebTransport, and begins playing streams.

**Mobile access**: Open `https://<your-LAN-IP>:5173` on your phone (same network). Accept the certificate warning. The dev server serves over HTTPS so WebCodecs is available in the secure context.

## Usage

- **Grid layout**: Click 1x1, 2x2, 3x3, or 4x4 buttons to change grid columns
- **Add/Remove streams**: Use the + Stream / - Stream buttons
- **Upscale mode**: Select from 9 GPU upscaling modes in the dropdown — bilinear, Lanczos, FSR, DLSS, spectral, temporal, VQSR, generative, compute
- **Comparison mode**: Toggle to show upscaled vs. original side-by-side for each stream
- **Zoom (desktop)**: Drag a rectangle on any tile to zoom into that area; double-click to reset
- **Zoom (mobile)**: Pinch-to-zoom with two fingers; one-finger pan when zoomed; double-tap to zoom 2x or reset
- **Stream overlay**: Per-tile overlay shows FPS, resolution, bitrate, decode time, and frame drops
- **Dashboard**: Toggle the global performance overlay
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
├── bridge-server/              # Node.js WebTransport bridge (RTSP → QUIC)
│   ├── src/
│   │   ├── index.ts                # HTTP/1.1 REST API + HTTP/3 WebTransport server
│   │   ├── stream-manager.ts       # RTSP stream lifecycle + per-client multiplexing
│   │   ├── rtsp-client.ts          # FFmpeg subprocess for RTSP reading
│   │   ├── rtsp-auth-proxy.ts      # RTSP Digest auth proxy (FFmpeg 8.x workaround)
│   │   ├── h264-parser.ts          # NAL unit parsing, SPS decode, codec string
│   │   ├── cert-utils.ts           # ECDSA P-256 self-signed cert generation
│   │   ├── framing.ts              # 4-byte length-prefix framing for QUIC streams
│   │   └── ws-handler.ts           # WebSocket fallback handler
│   └── tests/
├── client/                     # Vite TypeScript browser app (zero runtime deps)
│   ├── src/
│   │   ├── main.ts                 # App controller, CSS grid, UI wiring
│   │   ├── worker/
│   │   │   ├── stream-worker.ts        # Web Worker: owns decode + render pipeline
│   │   │   ├── offscreen-renderer.ts   # OffscreenCanvas WebGPU renderer per stream
│   │   │   └── messages.ts             # Worker ↔ main thread message types
│   │   ├── stream/
│   │   │   ├── wt-receiver.ts          # WebTransport client + binary protocol parser
│   │   │   ├── stream-pipeline.ts      # Per-stream decode pipeline orchestrator
│   │   │   ├── h264-demuxer.ts         # Annex B → EncodedVideoChunk
│   │   │   └── decoder.ts             # VideoDecoder wrapper with backpressure
│   │   ├── render/
│   │   │   ├── gpu-renderer.ts         # WebGPU render pipeline setup
│   │   │   ├── canvas2d-renderer.ts    # Canvas2D fallback renderer
│   │   │   ├── stream-tile.ts          # Per-stream canvas + label overlay
│   │   │   ├── grid-layout.ts          # Grid viewport calculations
│   │   │   ├── texture-manager.ts      # GPU texture lifecycle management
│   │   │   ├── shaders.wgsl            # Core vertex/fragment shaders
│   │   │   ├── compute-shaders.wgsl    # Compute upscaling shader
│   │   │   ├── dlss-shaders.wgsl       # DLSS-style temporal upscaling
│   │   │   ├── spectral-shaders.wgsl   # Spectral analysis upscaling
│   │   │   ├── temporal-shaders.wgsl   # Temporal accumulation upscaling
│   │   │   ├── vqsr-shaders.wgsl       # VQSR super-resolution
│   │   │   └── gen-shaders.wgsl        # Generative upscaling
│   │   ├── perf/
│   │   │   ├── metrics-collector.ts    # FPS, latency, memory tracking
│   │   │   ├── dashboard.ts            # Real-time metrics UI overlay
│   │   │   └── benchmark-runner.ts     # Automated stream scaling benchmark
│   │   ├── ui/
│   │   │   ├── controls.ts             # Stream control panel
│   │   │   ├── stream-overlay.ts       # Per-tile metrics overlay
│   │   │   └── styles.css              # Global styles
│   │   └── utils/
│   │       ├── logger.ts               # Tagged debug logging
│   │       └── device.ts               # Mobile/desktop device detection
│   └── tests/
├── docker/                     # Docker Compose + MediaMTX config
│   ├── docker-compose.yml
│   └── mediamtx.yml
├── scripts/
│   ├── setup-test-env.sh           # One-time setup (download videos, start Docker)
│   ├── generate-streams.sh         # Spawn FFmpeg RTSP stream publishers
│   └── run-benchmark.sh            # Automated benchmark runner
├── CLAUDE.md                   # AI assistant context
└── package.json                # Monorepo root (npm workspaces)
```

## Testing

```bash
npm test                 # All tests (bridge + client)
npm run test:bridge      # Bridge server tests only
npm run test:client      # Client tests only
npm run typecheck        # TypeScript type checking (both packages)
```

## Key Technical Details

- **WebTransport binary protocol**: 12-byte header (1B version + 2B streamId + 8B timestamp + 1B flags) followed by H.264 Annex B payload. All messages use 4-byte big-endian length-prefix framing since QUIC streams are byte-oriented. Config frames carry SPS/PPS for decoder initialization; video frames carry complete access units.
- **Zero-copy GPU rendering**: `importExternalTexture(VideoFrame)` creates a `GPUExternalTexture` that references the decoded frame directly on the GPU — no CPU-side pixel copies. The external texture is only valid until the current microtask ends, so `importExternalTexture` + render pass + `queue.submit()` must happen synchronously.
- **Web Worker pipeline**: All decode and render work runs in a dedicated Web Worker via `OffscreenCanvas`. The main thread only handles DOM, layout, and UI. Frames are batched into a single `rAF`-gated GPU submit per vsync.
- **BYOB stream reader**: Uses `ReadableStreamBYOBReader` to read WebTransport QUIC streams with zero browser-side allocation per read. A stable accumulation buffer with doubling growth and `copyWithin` compaction avoids O(n²) concat+slice patterns.
- **Certificate pinning**: The bridge server generates an ECDSA P-256 self-signed certificate at startup (≤14 days validity). The client fetches the SHA-256 hash via the REST API and passes it to `WebTransport` via `serverCertificateHashes`.
- **Backpressure**: Graduated thresholds on `decodeQueueSize` — accept all at ≤2, drop B-frames at 3, drop all non-keyframes at ≥4. Keyframes are never dropped.
- **VideoFrame lifecycle**: Every `VideoFrame` from the decoder is closed after GPU submit via `frame.close()` to prevent GPU memory leaks.
- **GPU upscaling modes**: 9 shader-based upscaling pipelines — bilinear (default sampler), Lanczos (windowed sinc), FSR (AMD FidelityFX-style edge sharpening), DLSS-style (temporal accumulation with motion vectors), spectral (frequency-domain enhancement), temporal (multi-frame accumulation), VQSR (learned super-resolution approximation), generative (detail synthesis), and compute (compute shader upscale).

## Browser Support

### Desktop

| Browser | WebTransport | WebGPU | WebCodecs | Status |
|---------|-------------|--------|-----------|--------|
| Chrome 114+ | Yes | Yes | Yes | **Full support** |
| Edge 114+ | Yes | Yes | Yes | **Full support** |
| Firefox 133+ | Yes | Yes | Yes | Functional (not primary target) |
| Safari 18+ | Behind flag | Partial | Yes | Not supported |

### Mobile

| Browser | WebTransport | WebGPU | WebCodecs | Status |
|---------|-------------|--------|-----------|--------|
| Chrome Android 123+ | Yes | Yes | Yes | **Full support** (Android 12+, Qualcomm/ARM GPU) |
| Edge Android 113+ | Yes | Yes | Yes | **Full support** (same engine as Chrome) |
| Samsung Internet 25+ | Yes | Yes | Yes | **Full support** (Chromium-based) |
| Safari iOS 26+ | Behind flag | Yes | Yes | **Partial** — WebSocket fallback works, WebTransport experimental |
| Firefox Android | No | No | No | Not supported |

### Notes

- **Chrome Android** is the primary mobile target — the only mobile browser where all three APIs (WebTransport + WebGPU + WebCodecs) are stable. Requires Android 12+ with a Qualcomm or ARM GPU for WebGPU.
- **WebGPU GPU blocklist**: Some mobile GPUs (e.g. Samsung Xclipse 920 / Exynos 2200) are on Chrome's adapter blocklist even though the hardware is capable. The app automatically falls back to Canvas2D rendering with a diagnostic badge. To force WebGPU, enable `chrome://flags/#enable-unsafe-webgpu` and restart Chrome.
- **Safari iOS 26** (released 2025) adds WebGPU with `importExternalTexture` support and WebCodecs `VideoDecoder`. WebTransport remains experimental (behind a flag), but the client's WebSocket fallback enables video playback. GPU upscaling and zero-copy rendering work fully.
- **Samsung Internet / Edge Android** are Chromium-based and inherit Chrome's API support, subject to the same Android 12+ / GPU hardware requirements for WebGPU.
- The client includes a **WebSocket fallback** for transport and **Canvas2D fallback** for rendering, so basic playback works on browsers missing WebTransport or WebGPU. The full feature set (GPU upscaling, zero-copy rendering, QUIC streaming) requires Chrome or Edge 114+ (desktop) or Chrome Android 123+ (mobile).
- **HTTPS required**: The Vite dev server uses `@vitejs/plugin-basic-ssl` to serve over HTTPS. This is necessary because WebCodecs (`VideoDecoder`) is only available in secure contexts. On `localhost`, plain HTTP works (implicit secure context), but LAN access from mobile devices requires HTTPS. REST API calls are proxied through Vite's `/api` route to avoid mixed-content errors.

## License

MIT
