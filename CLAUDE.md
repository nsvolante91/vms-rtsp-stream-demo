# VMS Browser Prototype — Claude Code Context

## What This Project Is

A browser-based Video Management System prototype demonstrating maximum video streaming performance using modern web APIs. The prototype shows that browsers can decode and render multiple simultaneous H.264 video streams using hardware acceleration, approaching native desktop performance.

## Architecture

Three main components:

1. **Test Environment** (Docker): MediaMTX RTSP server + FFmpeg looping test videos as simulated cameras
2. **Bridge Server** (Node.js/TypeScript): Reads RTSP streams, extracts H.264 NAL units, serves them over WebSocket with a simple binary protocol
3. **Browser Client** (TypeScript/Vite): Receives H.264 over WebSocket, decodes via WebCodecs (`VideoDecoder` with hardware acceleration), renders via WebGPU (`importExternalTexture` for zero-copy GPU rendering), displays in a configurable grid layout with real-time performance metrics

## Key Technical Constraints

- **VideoFrame.close() is mandatory** — every frame from the decoder MUST be closed after rendering, or GPU memory leaks catastrophically
- **importExternalTexture lifetime** — the GPUExternalTexture is only valid until the current microtask completes; must use it in the same synchronous render pass
- **Backpressure** — check `decoder.decodeQueueSize` before feeding frames; drop non-keyframes when queue > 3
- **H.264 codec string** — must be derived from SPS NAL unit: `avc1.{profile}{constraints}{level}` in hex
- **Chrome-first** — target Chrome 113+; WebGPU importExternalTexture is not in Firefox yet

## Build & Run

```bash
# Install
npm install

# Start Docker (MediaMTX)
docker compose -f docker/docker-compose.yml up -d

# Start test streams
./scripts/generate-streams.sh 4

# Start bridge server
npm run bridge

# Start client dev server
npm run dev
```

## Testing

```bash
npm test                 # All tests
npm run test:bridge      # Bridge server tests
npm run test:client      # Client tests
npm run typecheck        # TypeScript type checking
```

## Project Layout

- `bridge-server/` — Node.js TypeScript WebSocket server
- `client/` — Vite TypeScript browser application
- `docker/` — Docker Compose + MediaMTX config
- `scripts/` — Setup and automation scripts
- `test-videos/` — Downloaded test video files (gitignored)
- `.ralph/` — Ralph autonomous development configuration

## Coding Standards

- TypeScript strict mode
- All public functions have JSDoc comments
- No runtime dependencies in the browser client (all native APIs)
- Prefer `performance.now()` for timing, not `Date.now()`
- All WebSocket messages are binary (ArrayBuffer) except subscribe/unsubscribe (JSON text)
- Use `const` by default, `let` only when reassignment is needed
