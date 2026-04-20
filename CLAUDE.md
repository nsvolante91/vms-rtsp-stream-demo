# VMS Browser Prototype — Claude Code Context

## What This Project Is

A browser-based Video Management System prototype demonstrating maximum video streaming performance using modern web APIs. The prototype shows that browsers can decode and render multiple simultaneous H.264 video streams using hardware acceleration, approaching native desktop performance.

## Architecture

Three main components:

1. **Video Sources**: Either local MP4 files (FFmpeg demux, no re-encoding) or RTSP streams from IP cameras. Controlled via `SOURCE_MODE` env var (`local`, `rtsp`, or `auto`).
2. **Bridge Server** (Node.js/TypeScript): Spawns FFmpeg to output RTP packets to local UDP ports (`RTPSource` base class with `RTSPRTPSource` and `LocalRTPSource` subclasses), captures raw RTP packets via UDP sockets, forwards them over WebTransport (HTTP/3 QUIC) with a minimal 2-byte stream ID prefix. The server is a transparent RTP relay — no H.264 parsing is performed. Codec configuration (SPS/PPS) is extracted from FFmpeg's SDP output and sent as JSON control messages.
3. **Browser Client** (TypeScript/Vite): Receives raw RTP packets over WebTransport, depacketizes H.264 per RFC 6184 (`RTPDepacketizer` handles Single NAL, STAP-A, FU-A), converts to AVCC format for WebCodecs (`VideoDecoder` with hardware acceleration), renders via WebGPU (`importExternalTexture` for zero-copy GPU rendering), displays in a configurable grid layout with real-time performance metrics

## Key Technical Constraints

- **VideoFrame.close() is mandatory** — every frame from the decoder MUST be closed after rendering, or GPU memory leaks catastrophically
- **importExternalTexture lifetime** — the GPUExternalTexture is only valid until the current microtask completes; must use it in the same synchronous render pass
- **Backpressure** — check `decoder.decodeQueueSize` before feeding frames; drop non-keyframes when queue > 3
- **H.264 codec string** — derived from SPS NAL unit (available in SDP `profile-level-id` or SPS bytes): `avc1.{profile}{constraints}{level}` in hex
- **RTP depacketization** — client handles RFC 6184 packet types: Single NAL (1-23), STAP-A (24), FU-A (28); uses marker bit for access unit boundaries
- **Chrome-first** — target Chrome 114+; WebTransport + WebGPU importExternalTexture require Chrome
- **WebTransport framing** — QUIC streams are byte-oriented; all messages use 4-byte big-endian length prefix; video data is `[2-byte stream ID][raw RTP packet]`
- **Self-signed certs** — WebTransport requires TLS; bridge server generates ECDSA P-256 cert at startup (≤14 days validity); client pins via `serverCertificateHashes`

## Build & Run

```bash
# Install
npm install

# Download test videos
./scripts/setup-test-env.sh

# Start bridge server (local file mode — no Docker needed)
npm run bridge:local

# Start client dev server
npm run dev
```

### RTSP mode (optional, requires IP cameras)

```bash
RTSP_BASE_URL=rtsp://user:pass@camera-ip:554/stream SOURCE_MODE=rtsp npm run bridge
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

- `bridge-server/` — Node.js TypeScript WebTransport server
- `client/` — Vite TypeScript browser application
- `scripts/` — Setup and automation scripts
- `test-videos/` — Downloaded test video files (gitignored)
- `.ralph/` — Ralph autonomous development configuration

## Coding Standards

- TypeScript strict mode
- All public functions have JSDoc comments
- No runtime dependencies in the browser client (all native APIs)
- Prefer `performance.now()` for timing, not `Date.now()`
- All WebTransport control messages are length-prefixed JSON on a bidirectional stream (including `codec-config` messages with base64 SPS/PPS from SDP)
- All video data (raw RTP packets with 2-byte stream ID prefix) is multiplexed over a single unidirectional QUIC stream per client
- Use `const` by default, `let` only when reassignment is needed
