# VMS Browser Prototype — Development Task List

## Phase 1: Foundation (Bridge Server + Single Stream)

### Priority: CRITICAL — Infrastructure

- [x] Create root `package.json` with npm workspaces for `bridge-server/` and `client/`
- [x] Initialize `bridge-server/` with TypeScript and build scripts
- [x] Initialize `client/` with Vite, TypeScript, and `vitest`
- [x] Create `docker/docker-compose.yml` with MediaMTX service
- [x] Create `docker/mediamtx.yml` with path config for streams
- [x] Create `scripts/setup-test-env.sh` that downloads test videos and starts Docker
- [x] Create `scripts/generate-streams.sh` that launches N FFmpeg→RTSP loops

### Priority: CRITICAL — Bridge Server Core (WebTransport)

> **Note:** Originally planned with WebSocket (`ws`), migrated to WebTransport
> (HTTP/3 QUIC) via `@fails-components/webtransport` for zero head-of-line
> blocking between video streams. See `webtransport-solution.md` for the ADR.

- [x] Implement `bridge-server/src/h264-parser.ts` — NAL unit detection, SPS parsing, Annex B building
- [x] Write tests for `h264-parser.ts` — SPS parsing extracts correct resolution, profile, level (30 tests)
- [x] Implement `bridge-server/src/rtsp-client.ts` — FFmpeg child process approach, stdout NAL parsing
- [x] Implement `bridge-server/src/stream-manager.ts` — manages RTSP clients, routes to WebTransport clients via shared unidirectional QUIC stream per client
- [x] Implement `bridge-server/src/index.ts` — Http3Server (WebTransport) + HTTP/1.1 REST API for stream listing and cert-hash
- [x] Implement `bridge-server/src/cert-utils.ts` — ECDSA P-256 self-signed cert generation for WebTransport TLS
- [x] Implement `bridge-server/src/framing.ts` — 4-byte length-prefix framing for QUIC byte streams
- [x] Implement `bridge-server/src/types/webtransport.d.ts` — ambient type declarations for @fails-components/webtransport
- [x] Verify: bridge server connects to MediaMTX RTSP stream and outputs NAL units
- [x] Verify: WebTransport client receives binary frames with correct header format

### Priority: CRITICAL — Browser Single Stream Decode

- [x] Implement `client/src/stream/wt-receiver.ts` — WebTransport binary message parsing with cert pinning, multiplexed streams, auto-reconnect
- [x] Implement `client/src/stream/h264-demuxer.ts` — Annex B → EncodedVideoChunk + codec string generation
- [x] Implement `client/src/stream/decoder.ts` — WebCodecs VideoDecoder wrapper with backpressure
- [x] Implement `client/src/stream/stream-pipeline.ts` — transport-agnostic StreamReceiver interface, orchestrates receive→decode
- [x] Create `client/index.html` — minimal page with canvas + browser compatibility check
- [x] Create `client/src/main.ts` — bootstrap, feature detection, WebTransport connect, auto-add streams
- [x] **MILESTONE: One video stream decodes in browser via WebCodecs and renders to Canvas2D**

## Phase 2: WebGPU Rendering

### Priority: HIGH — GPU Pipeline

- [x] Implement `client/src/render/shaders.wgsl` — vertex + fragment shaders for `texture_external` with viewport uniforms and `textureSampleBaseClampToEdge`
- [x] Implement `client/src/render/gpu-renderer.ts` — WebGPU init, pipeline, multi-stream render in single pass with viewport uniforms; delegates to TextureManager
- [x] Implement `client/src/render/texture-manager.ts` — `importExternalTexture` lifecycle management, import/release/error tracking, guaranteed `frame.close()` via try/finally
- [x] Replace Canvas2D rendering with WebGPU in stream pipeline — `StreamTile` now uses per-tile `GPUCanvasContext` with shared device/pipeline/sampler via `initSharedGPU()`; automatic Canvas2D fallback
- [x] Verify: single stream renders via WebGPU with zero-copy `importExternalTexture`
- [x] Verify: no GPU memory leak (`VideoFrame.close()` called on every frame in both WebGPU and Canvas2D paths via try/finally)

## Phase 3: Multi-Stream Grid

### Priority: HIGH — Grid Rendering

> **Note:** All Phase 3 items were implemented during Phases 1–2 as part of
> the full-stack buildout. `grid-layout.ts` provides `calculateGrid()` and
> `calculateFocusLayout()` with 11 passing tests. Per-tile WebGPU rendering
> with shared device/pipeline/sampler handles multi-stream display. VMSApp
> in `main.ts` orchestrates concurrent `StreamPipeline` instances, CSS grid
> layout switching (1–4 columns), add/remove stream controls, and click-to-focus.

- [x] Implement `client/src/render/grid-layout.ts` — `calculateGrid()` and `calculateFocusLayout()` for N streams
- [x] Write tests for `grid-layout.ts` — 11 tests covering 1×1, 2×2, 3×3, 4×4 viewport positions and focus layout
- [x] Update `gpu-renderer.ts` — render multiple quads per frame with viewport uniform buffers
- [x] Update `stream-pipeline.ts` — each stream gets its own independent `StreamPipeline` instance, all run concurrently
- [x] Implement `VMSApp` controller in `main.ts` — manages pipelines + per-tile rendering + CSS grid + focus mode + benchmark
- [x] Implement grid layout switching UI (buttons for 1, 2, 3, 4 columns) in `controls.ts` with active state toggle
- [x] Implement add/remove stream UI controls (`btn-add-stream`, `btn-remove-stream`) in `controls.ts`
- [x] **MILESTONE: 4+ simultaneous streams render in a configurable grid via WebGPU (up to 16 streams)**

## Phase 4: Performance Dashboard + Benchmark

### Priority: MEDIUM — Metrics

> **Note:** All Phase 4 items were implemented during earlier phases.
> `metrics-collector.ts` tracks per-stream FPS, decode time, dropped frames,
> queue size, bitrate, and global totals. `dashboard.ts` renders a 1Hz DOM
> overlay with FPS color-coding (green >25, yellow 15-25, red <15).
> `benchmark-runner.ts` progressively adds 1→16 streams and produces a
> `BenchmarkReport` with max sustainable stream count.

- [x] Implement `client/src/perf/metrics-collector.ts` — per-stream and global metrics with `recordFrame()`, `updateQueueSize()`, `getStreamMetrics()`, `getGlobalMetrics()`
- [x] Implement `client/src/perf/dashboard.ts` — DOM overlay with live stats at 1Hz
- [x] Dashboard shows: FPS per stream, decode time, memory, bandwidth, render time, dropped frames, queue size
- [x] Dashboard color-codes FPS: green (>25), yellow (15-25), red (<15)
- [x] Toggle dashboard with 'D' key (wired in `controls.ts`)
- [x] Implement `client/src/perf/benchmark-runner.ts` — automated progressive stream addition with stabilize + measure windows
- [x] Benchmark produces report: max sustainable streams, per-level metrics (`BenchmarkReport`)
- [x] Add CSV export for benchmark data (`MetricsCollector.exportCSV()`)
- [x] Add JSON export for benchmark report (`downloadJSON()` in `main.ts`)
- [x] **MILESTONE: Benchmark runs 1→16 streams, produces performance report**

## Phase 5: Polish + Focus Mode + Documentation

### Priority: MEDIUM — UX

- [x] Implement click-to-zoom: clicking a tile toggles focus mode (single tile fills grid, others hidden)
- [x] Click again returns to grid view (`toggleFocus()` in `main.ts`)
- [x] Show stream label (ID, resolution, FPS) on each tile (`updateLabel()` in `StreamTile`)
- [x] Add minimal CSS styling — dark theme, clean layout (`styles.css`)

### Priority: MEDIUM — Resilience

- [x] Handle decoder errors with automatic reset + wait for keyframe (`decoder.ts` `handleError()` with `_waitingForKeyframe`)
- [x] Handle WebTransport disconnection with reconnection + exponential backoff (`wt-receiver.ts`)
- [x] Handle frame drops gracefully — skip to next keyframe when behind (`decoder.ts` backpressure with `MAX_QUEUE_SIZE`)
- [ ] Handle browser tab visibility change — pause decode when hidden

### Priority: NORMAL — Documentation

- [x] Write `README.md` with complete quickstart (prerequisites, setup, run, benchmark)
- [ ] Update `README.md` to reflect WebTransport + WebGPU architecture (currently references WebSocket + Canvas2D)
- [ ] Write `docs/ARCHITECTURE.md` with component diagram and data flow
- [ ] Write `docs/BENCHMARKS.md` explaining what the metrics mean
- [x] Add inline JSDoc comments to all public methods
- [x] Create `CLAUDE.md` for Claude Code project context

### Priority: LOW — Nice to Have

- [ ] WebGPU adapter info in benchmark report (GPU name, limits)
- [x] Fallback to Canvas2D + `drawImage(videoFrame)` if WebGPU unavailable (automatic in `StreamTile`)
- [ ] Stream reconnection with seamless resume
- [ ] Dark/light theme toggle
- [ ] Fullscreen mode

## Completion Criteria

All "CRITICAL" and "HIGH" tasks must be checked off. Final validation:

1. `scripts/setup-test-env.sh` downloads videos and starts Docker environment
2. `npm install` in root installs all dependencies
3. `npm run bridge` starts the bridge server connecting to RTSP streams
4. `npm run dev` starts the Vite dev server
5. Opening `http://localhost:5173` shows the VMS UI with live video
6. Grid layout buttons switch between 1×1, 2×2, 3×3, 4×4
7. Performance dashboard shows real-time metrics
8. Clicking "Run Benchmark" produces a performance report
9. `npm test` passes all tests
10. `README.md` contains working copy-paste instructions
