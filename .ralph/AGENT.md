# VMS Prototype — Build & Run Commands

## Prerequisites

- **Node.js** 20+ (for bridge server and Vite)
- **Docker** + Docker Compose (for MediaMTX + test streams)
- **FFmpeg** (on host for generating test videos; also used in Docker)
- **Chrome 113+** or **Edge 113+** (for WebGPU + WebCodecs)

## Initial Setup

```bash
# 1. Install all dependencies (npm workspaces)
npm install

# 2. Download test videos + start Docker environment
chmod +x scripts/setup-test-env.sh
./scripts/setup-test-env.sh

# 3. Generate RTSP test streams (starts FFmpeg loops)
chmod +x scripts/generate-streams.sh
./scripts/generate-streams.sh 4   # Start 4 simulated camera streams
```

## Running

```bash
# Terminal 1: Start Docker (MediaMTX RTSP server)
docker compose -f docker/docker-compose.yml up

# Terminal 2: Start bridge server
npm run bridge

# Terminal 3: Start browser client dev server
npm run dev
# Opens at http://localhost:5173
```

## Testing

```bash
# Run all tests
npm test

# Run bridge server tests only
npm run test:bridge

# Run client tests only
npm run test:client

# Run tests in watch mode
npm run test:watch
```

## Build

```bash
# Type-check everything
npm run typecheck

# Build client for production
npm run build

# Build bridge server
npm run build:bridge
```

## Docker Management

```bash
# Start test environment
docker compose -f docker/docker-compose.yml up -d

# Stop test environment
docker compose -f docker/docker-compose.yml down

# View MediaMTX logs
docker compose -f docker/docker-compose.yml logs mediamtx

# Check active RTSP paths
curl http://localhost:9997/v3/paths/list
```

## Benchmark

```bash
# Run automated benchmark (opens browser, adds streams progressively)
npm run benchmark

# Or manually in the browser UI:
# 1. Open http://localhost:5173
# 2. Press 'D' to show dashboard
# 3. Click "Run Benchmark" button
# 4. Wait for completion
# 5. Click "Export Results" to download CSV/JSON
```

## Useful FFmpeg Commands

```bash
# Publish a local video as RTSP stream (for manual testing)
ffmpeg -re -stream_loop -1 -i test-videos/BigBuckBunny.mp4 \
  -c:v copy -an -f rtsp rtsp://localhost:8554/manual_stream

# Check if RTSP stream is working
ffplay -rtsp_transport tcp rtsp://localhost:8554/stream1

# Generate a 4K test video from 1080p source
ffmpeg -i test-videos/BigBuckBunny.mp4 -vf scale=3840:2160 \
  -c:v libx264 -preset fast -crf 23 test-videos/bbb_4k.mp4
```

## Project Structure Notes

- `bridge-server/` — Node.js TypeScript, compiles to `bridge-server/dist/`
- `client/` — Vite + TypeScript, builds to `client/dist/`
- `docker/` — Docker Compose and config files
- `scripts/` — Shell scripts for setup and automation
- `test-videos/` — Downloaded test video files (gitignored)
- `docs/` — Architecture and benchmark documentation

## Troubleshooting

- **WebGPU not available:** Use Chrome 113+ or Edge 113+. Check `chrome://gpu` for WebGPU status.
- **No hardware decode:** Check `chrome://media-internals` while playing. Look for "MojoVideoDecoder" or "D3D11VideoDecoder".
- **Docker network issues:** Use `--network=host` on Linux or ensure port mappings are correct on Mac/Windows.
- **FFmpeg not found in bridge server:** Ensure FFmpeg is installed on the host (not just in Docker).
- **RTSP connection refused:** Verify MediaMTX is running: `curl http://localhost:9997/v3/paths/list`
