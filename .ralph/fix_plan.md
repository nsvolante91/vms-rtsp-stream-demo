# VMS Browser Prototype — Development Task List

## Phase 1: Foundation (Bridge Server + Single Stream)

### Priority: CRITICAL — Infrastructure

- [ ] Create root `package.json` with npm workspaces for `bridge-server/` and `client/`
- [ ] Initialize `bridge-server/` with TypeScript, `ws`, and build scripts
- [ ] Initialize `client/` with Vite, TypeScript, and `vitest`
- [ ] Create `docker/docker-compose.yml` with MediaMTX service
- [ ] Create `docker/mediamtx.yml` with path config for streams
- [ ] Create `scripts/setup-test-env.sh` that downloads test videos and starts Docker
- [ ] Create `scripts/generate-streams.sh` that launches N FFmpeg→RTSP loops

### Priority: CRITICAL — Bridge Server Core

- [ ] Implement `bridge-server/src/h264-parser.ts` — NAL unit detection, SPS parsing, Annex B building
- [ ] Write tests for `h264-parser.ts` — SPS parsing extracts correct resolution, profile, level
- [ ] Implement `bridge-server/src/rtsp-client.ts` — FFmpeg child process approach, stdout NAL parsing
- [ ] Implement `bridge-server/src/stream-manager.ts` — manages RTSP clients, routes to WS clients
- [ ] Implement `bridge-server/src/index.ts` — WS server, REST API for stream listing
- [ ] Verify: bridge server connects to MediaMTX RTSP stream and outputs NAL units
- [ ] Verify: WebSocket client receives binary frames with correct header format

### Priority: CRITICAL — Browser Single Stream Decode

- [ ] Implement `client/src/stream/ws-receiver.ts` — WebSocket binary message parsing
- [ ] Implement `client/src/stream/h264-demuxer.ts` — Annex B → EncodedVideoChunk + codec string generation
- [ ] Write tests for `h264-demuxer.ts` — codec string formatting, chunk type detection
- [ ] Implement `client/src/stream/decoder.ts` — WebCodecs VideoDecoder wrapper with backpressure
- [ ] Implement `client/src/stream/stream-pipeline.ts` — orchestrates single stream receive→decode
- [ ] Create `client/index.html` — minimal page with canvas + browser compatibility check
- [ ] Create `client/src/main.ts` — bootstrap, feature detection, single stream test
- [ ] **MILESTONE: One video stream decodes in browser via WebCodecs and renders to Canvas2D**

## Phase 2: WebGPU Rendering

### Priority: HIGH — GPU Pipeline

- [ ] Implement `client/src/render/shaders.wgsl` — vertex + fragment shaders for external texture
- [ ] Implement `client/src/render/gpu-renderer.ts` — WebGPU init, pipeline, single-stream render
- [ ] Implement `client/src/render/texture-manager.ts` — importExternalTexture lifecycle
- [ ] Replace Canvas2D rendering with WebGPU in stream pipeline
- [ ] Verify: single stream renders via WebGPU with zero-copy importExternalTexture
- [ ] Verify: no GPU memory leak (VideoFrame.close() called on every frame)

## Phase 3: Multi-Stream Grid

### Priority: HIGH — Grid Rendering

- [ ] Implement `client/src/render/grid-layout.ts` — viewport calculation for N streams in grid
- [ ] Write tests for `grid-layout.ts` — 1×1, 2×2, 3×3, 4×4 viewport positions correct
- [ ] Update `gpu-renderer.ts` — render multiple quads per frame with viewport uniforms
- [ ] Update `stream-pipeline.ts` — support multiple concurrent pipelines
- [ ] Implement `VMSApp` controller in `main.ts` — manages pipelines + renderer + render loop
- [ ] Implement grid layout switching UI (buttons for 1, 4, 9, 16)
- [ ] Implement add/remove stream UI controls
- [ ] **MILESTONE: 4 simultaneous streams render in a 2×2 grid via WebGPU**

## Phase 4: Performance Dashboard + Benchmark

### Priority: MEDIUM — Metrics

- [ ] Implement `client/src/perf/metrics-collector.ts` — per-stream and global metrics
- [ ] Implement `client/src/perf/dashboard.ts` — DOM overlay with live stats
- [ ] Dashboard shows: FPS per stream, decode time, memory, CPU frame budget, drops
- [ ] Dashboard color-codes FPS: green (>25), yellow (15-25), red (<15)
- [ ] Toggle dashboard with 'D' key
- [ ] Implement `client/src/perf/benchmark-runner.ts` — automated progressive stream addition
- [ ] Benchmark produces report: max sustainable streams, per-level metrics
- [ ] Add CSV export for benchmark data
- [ ] Add JSON export for benchmark report
- [ ] **MILESTONE: Benchmark runs 1→16 streams, produces performance report**

## Phase 5: Polish + Focus Mode + Documentation

### Priority: MEDIUM — UX

- [ ] Implement click-to-zoom: clicking a tile makes it 75% of canvas, others in sidebar
- [ ] Click again (or Esc) returns to grid view
- [ ] Show stream label (ID, resolution, FPS) on each tile
- [ ] Add minimal CSS styling — dark theme, clean layout

### Priority: MEDIUM — Resilience

- [ ] Handle decoder errors with automatic reset + wait for keyframe
- [ ] Handle WebSocket disconnection with reconnection + backoff
- [ ] Handle frame drops gracefully — skip to next keyframe when behind
- [ ] Handle browser tab visibility change — pause decode when hidden

### Priority: NORMAL — Documentation

- [ ] Write `README.md` with complete quickstart (prerequisites, setup, run, benchmark)
- [ ] Write `docs/ARCHITECTURE.md` with component diagram and data flow
- [ ] Write `docs/BENCHMARKS.md` explaining what the metrics mean
- [ ] Add inline JSDoc comments to all public methods
- [ ] Create `CLAUDE.md` for Claude Code project context

### Priority: LOW — Nice to Have

- [ ] WebGPU adapter info in benchmark report (GPU name, limits)
- [ ] Fallback to Canvas2D + `drawImage(videoFrame)` if WebGPU unavailable
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
