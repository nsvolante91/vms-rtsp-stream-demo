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
Local MP4 files ─────────▶ Bridge Server ──WebSocket/WebTransport──▶ Browser
  (FFmpeg demux, no re-encode)  (Node.js)                           (WebCodecs + Canvas2D)

   ── or ──

RTSP cameras ──RTSP──▶ Bridge Server ──WebSocket/WebTransport──▶ Browser
  (IP cameras)              (Node.js)                              (WebCodecs + Canvas2D)
```

The bridge server supports two source types:
1. **Local files** (default): FFmpeg demuxes MP4 files directly to H.264 Annex B — no re-encoding, no external servers
2. **RTSP streams**: Reads directly from IP cameras via FFmpeg

Both source types produce identical output to the browser client — the same 12-byte binary frame header with H.264 access units.

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 20+ | Bridge server + build tooling |
| **FFmpeg** | 5+ (on host) | Demuxes video files / reads RTSP streams |
| **OpenSSL** | 1.1.1+ | Generates self-signed TLS certificate |
| **Chrome / Edge** | 113+ | WebTransport + WebCodecs (best performance) |
| **Safari** | 17+ | WebCodecs + WebSocket fallback (no WebTransport needed) |
| **Firefox** | 113+ | WebCodecs + WebSocket fallback |

## Quick Start (local, single machine)

You need **2 terminal windows**.

### 1. Clone and install

```bash
git clone https://github.com/nsvolante91/vms-rtsp-stream-demo.git
cd vms-rtsp-stream-demo
npm install
```

### 2. Set up test videos

```bash
./scripts/setup-test-env.sh
```

Downloads Big Buck Bunny and Tears of Steel sample videos to `test-videos/` and generates 720p/480p variants.

### 3. Start the bridge server

```bash
npm run bridge:local
```

The bridge server will:
- Generate a self-signed TLS certificate in `.certs/` (required for WebTransport)
- Scan `test-videos/` for `.mp4` files and start streaming them

### 4. Start the browser client

```bash
npm run dev
```

Open **`https://localhost:5173`** in your browser.

> **⚠️ HTTPS is required.** The Vite dev server uses the same self-signed certificate from `.certs/`. Your browser will show a certificate warning on first load — click "Advanced → Proceed" to accept it. You only need to do this once per certificate rotation (every 13 days).

The client auto-detects available streams and begins playing.

## Running on a Remote Machine (LAN / server access)

When the bridge server and Vite run on a different machine than the browser, set the `HOST` env var to the machine's IP address (or hostname). This ensures:
1. The TLS certificate SAN covers the remote host (required by Chrome's WebTransport)
2. The Vite dev server binds to all interfaces instead of just localhost

**On the server:**

```bash
# Replace 192.168.1.100 with your server's IP or hostname
export HOST=192.168.1.100

# Start bridge server (generates cert with SAN for 192.168.1.100)
SOURCE_MODE=local HOST=$HOST npm run bridge:local

# In a second terminal — start Vite dev server
HOST=$HOST npm run dev
```

**On the client machine**, open:
```
https://192.168.1.100:5173
```

Accept the certificate warning on first load. Both REST API calls and WebSocket streaming are proxied through the Vite server, so you only need to accept one certificate.

> **Note for Chrome/Edge (WebTransport):** The WebTransport connection goes directly to `https://192.168.1.100:9001`. Make sure port `9001/UDP` is reachable from the client (not firewalled).
>
> **Note for Safari/Firefox (WebSocket fallback):** All traffic goes through the Vite proxy on port `5173`. Only port `5173/TCP` needs to be reachable.

### RTSP cameras (remote)

```bash
HOST=192.168.1.100 RTSP_BASE_URL=rtsp://user:pass@camera-ip:554/stream SOURCE_MODE=rtsp npm run bridge
HOST=192.168.1.100 npm run dev
```

## Certificate Trust

This prototype uses self-signed ECDSA P-256 certificates (13-day validity, required by Chrome's WebTransport spec). There are two trust steps:

| Step | What to do | Frequency |
|------|-----------|-----------|
| **Vite HTTPS page** | Click "Advanced → Proceed to …" in browser | Once per cert rotation |
| **WebTransport (Chrome/Edge only)** | Uses certificate hash pinning — no manual trust needed | Automatic |

The bridge server must be started **before** `npm run dev` so the certificate exists when Vite reads it from `.certs/`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Hostname or IP for the bridge server. Included in the TLS certificate SAN and used as the WebTransport URL sent to clients. Set to your machine's LAN IP for remote access. |
| `SOURCE_MODE` | `auto` | `local` = scan VIDEO_DIR for MP4s, `rtsp` = probe RTSP URLs, `auto` = try local first |
| `VIDEO_DIR` | `<project>/test-videos` | Directory to scan for local MP4 files |
| `RTSP_BASE_URL` | *(required for rtsp mode)* | RTSP URL for IP camera |
| `BRIDGE_PORT` | `9000` | HTTP REST API port |
| `WT_PORT` | `9001` | WebTransport (HTTP/3 QUIC) port |

## Browser Transport Support

| Browser | Transport | Notes |
|---------|-----------|-------|
| Chrome 113+ | WebTransport (HTTP/3) | Best performance — multiplexed QUIC streams |
| Edge 113+ | WebTransport (HTTP/3) | Same as Chrome |
| Safari 17+ | WebSocket (WSS) | Automatic fallback via Vite proxy |
| Firefox 113+ | WebSocket (WSS) | Automatic fallback via Vite proxy |

No configuration is needed — the client detects `typeof WebTransport` and selects the best available transport automatically.

## REST API

The REST API runs on `http://localhost:9000` (plain HTTP, proxied through Vite as `/api/*`).

```bash
# List available streams
curl http://localhost:9000/streams

# Add a stream manually
curl -X POST http://localhost:9000/streams -H 'Content-Type: application/json' \
  -d '{"filePath": "/path/to/test-videos/BigBuckBunny.mp4"}'

# Add an RTSP stream
curl -X POST http://localhost:9000/streams -H 'Content-Type: application/json' \
  -d '{"rtspUrl": "rtsp://user:pass@camera-ip:554/stream"}'

# Remove a stream
curl -X DELETE http://localhost:9000/streams/1

# Health check
curl http://localhost:9000/health
```

## Usage

- **Grid layout**: Click 1x1, 2x2, 3x3, or 4x4 buttons to change grid columns
- **Add/Remove streams**: Use the + Stream / - Stream buttons
- **Zoom**: Click any stream tile to focus it full-screen; click again to return to grid
- **Dashboard**: Toggle the performance overlay via the Dashboard button
- **Benchmark**: Click "Run Benchmark" to auto-test stream scaling limits
- **Export**: Click "Export Metrics" to download performance data as JSON

## Project Layout

```
├── bridge-server/          # Node.js bridge (file/RTSP → WebSocket/WebTransport)
│   ├── src/
│   │   ├── index.ts            # HTTP + WebTransport server, stream discovery
│   │   ├── cert-utils.ts       # Self-signed TLS certificate generation
│   │   ├── stream-manager.ts   # Stream lifecycle + access unit packaging
│   │   ├── ws-handler.ts       # WebSocket server (Safari/Firefox fallback)
│   │   ├── ffmpeg-source.ts    # Abstract base: FFmpeg process + NAL parsing
│   │   ├── rtsp-client.ts      # RTSP source (extends FFmpegSource)
│   │   ├── local-file-source.ts # Local MP4 source (extends FFmpegSource)
│   │   └── h264-parser.ts      # NAL unit parsing, SPS decode, codec string
│   └── tests/
├── client/                 # Vite TypeScript browser app (zero runtime deps)
│   ├── src/
│   │   ├── main.ts             # App controller, CSS grid management
│   │   ├── stream/
│   │   │   ├── wt-receiver.ts      # WebTransport client + binary protocol parser
│   │   │   ├── ws-receiver.ts      # WebSocket fallback (Safari/Firefox)
│   │   │   ├── stream-pipeline.ts  # Per-stream decode pipeline
│   │   │   ├── h264-demuxer.ts     # Annex B → EncodedVideoChunk
│   │   │   └── decoder.ts         # VideoDecoder wrapper with backpressure + auto-recovery
│   │   ├── render/
│   │   │   ├── stream-tile.ts     # Per-stream canvas + label overlay (Canvas2D)
│   │   │   ├── gpu-renderer.ts    # WebGPU renderer (partial, not yet active)
│   │   │   └── shaders.wgsl       # WGSL vertex/fragment shaders for WebGPU
│   │   ├── worker/
│   │   │   ├── stream-worker.ts   # Web Worker: transport → decode → render pipeline
│   │   │   └── messages.ts        # Main ↔ worker message types
│   │   ├── perf/
│   │   │   ├── metrics-collector.ts
│   │   │   ├── dashboard.ts
│   │   │   └── benchmark-runner.ts
│   │   └── ui/
│   │       ├── controls.ts
│   │       └── styles.css
│   ├── vite.config.ts          # HTTPS + proxy config
│   └── tests/
├── .certs/                 # Auto-generated TLS certificates (gitignored)
│   ├── cert.pem                # Self-signed ECDSA P-256 certificate
│   └── key.pem                 # Private key
├── scripts/
│   ├── setup-test-env.sh       # One-time setup (download test videos)
│   └── serve-local.sh          # Start bridge in local file mode
├── test-videos/            # Downloaded test videos (gitignored)
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
