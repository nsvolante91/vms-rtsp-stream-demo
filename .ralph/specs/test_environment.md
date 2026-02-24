# Test Environment Specification

## Overview

The test environment simulates multiple IP camera streams using:
- **MediaMTX** — RTSP server (Docker container)
- **FFmpeg** — Loops video files as simulated camera feeds (host or Docker)
- **Bridge Server** — Node.js process converting RTSP → WebSocket (host)

## Docker Compose Configuration

```yaml
# docker/docker-compose.yml
version: '3.8'

services:
  mediamtx:
    image: bluenviron/mediamtx:latest
    container_name: vms-mediamtx
    ports:
      - "8554:8554"   # RTSP
      - "8000:8000/udp" # RTP
      - "8001:8001/udp" # RTCP
      - "9997:9997"   # API
    volumes:
      - ./mediamtx.yml:/mediamtx.yml
    restart: unless-stopped
```

## MediaMTX Configuration

```yaml
# docker/mediamtx.yml
# Minimal config for test RTSP server

# Log level
logLevel: info

# RTSP settings
rtsp: true
rtspAddress: :8554
protocols: [tcp]

# Disable protocols we don't need
rtmp: false
hls: false
webrtc: false
srt: false

# API for checking paths
api: true
apiAddress: :9997

# Paths — accept any publisher
paths:
  all_others:
    source: publisher
```

## FFmpeg Stream Generation

```bash
#!/bin/bash
# scripts/generate-streams.sh
# Usage: ./generate-streams.sh [NUM_STREAMS] [RESOLUTION]
# Example: ./generate-streams.sh 4 1080p

NUM_STREAMS=${1:-4}
RESOLUTION=${2:-1080p}
VIDEO_DIR="test-videos"
RTSP_HOST="localhost"
RTSP_PORT="8554"

# Select video file based on resolution
case $RESOLUTION in
  4k)   VIDEO="$VIDEO_DIR/bbb_4k.mp4" ;;
  1080p) VIDEO="$VIDEO_DIR/BigBuckBunny.mp4" ;;
  720p)  VIDEO="$VIDEO_DIR/bbb_720p.mp4" ;;
  480p)  VIDEO="$VIDEO_DIR/bbb_480p.mp4" ;;
  *)     VIDEO="$VIDEO_DIR/BigBuckBunny.mp4" ;;
esac

if [ ! -f "$VIDEO" ]; then
  echo "Error: Video file not found: $VIDEO"
  echo "Run scripts/setup-test-env.sh first to download test videos."
  exit 1
fi

# Kill any existing FFmpeg streams
pkill -f "ffmpeg.*rtsp://.*stream" 2>/dev/null || true
sleep 1

echo "Starting $NUM_STREAMS RTSP streams at $RESOLUTION..."

for i in $(seq 1 $NUM_STREAMS); do
  STREAM_NAME="stream${i}"
  
  # Add slight time offset per stream so they're not perfectly in sync
  # This simulates real cameras with independent clocks
  OFFSET=$((i * 3))
  
  ffmpeg -hide_banner -loglevel warning \
    -re \
    -stream_loop -1 \
    -ss $OFFSET \
    -i "$VIDEO" \
    -c:v copy \
    -an \
    -f rtsp \
    -rtsp_transport tcp \
    "rtsp://${RTSP_HOST}:${RTSP_PORT}/${STREAM_NAME}" &
  
  echo "  Started $STREAM_NAME (PID: $!)"
  sleep 0.5  # Stagger starts to avoid overwhelming MediaMTX
done

echo ""
echo "All streams started. Verify with:"
echo "  curl http://localhost:9997/v3/paths/list"
echo ""
echo "Test playback with:"
echo "  ffplay -rtsp_transport tcp rtsp://localhost:8554/stream1"
echo ""
echo "Stop all streams with:"
echo "  pkill -f 'ffmpeg.*rtsp://.*stream'"
```

## Setup Script

```bash
#!/bin/bash
# scripts/setup-test-env.sh
# Downloads test videos and starts Docker environment

set -e

VIDEO_DIR="test-videos"
mkdir -p "$VIDEO_DIR"

echo "=== VMS Prototype Test Environment Setup ==="
echo ""

# 1. Download test videos (if not already present)
echo "Step 1: Downloading test videos..."

if [ ! -f "$VIDEO_DIR/BigBuckBunny.mp4" ]; then
  echo "  Downloading Big Buck Bunny (1080p)..."
  curl -L -o "$VIDEO_DIR/BigBuckBunny.mp4" \
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
else
  echo "  Big Buck Bunny already exists, skipping."
fi

if [ ! -f "$VIDEO_DIR/TearsOfSteel.mp4" ]; then
  echo "  Downloading Tears of Steel..."
  curl -L -o "$VIDEO_DIR/TearsOfSteel.mp4" \
    "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4"
else
  echo "  Tears of Steel already exists, skipping."
fi

# 2. Generate resolution variants
echo ""
echo "Step 2: Generating resolution variants..."

if command -v ffmpeg &> /dev/null; then
  if [ ! -f "$VIDEO_DIR/bbb_720p.mp4" ]; then
    echo "  Creating 720p variant..."
    ffmpeg -hide_banner -loglevel warning \
      -i "$VIDEO_DIR/BigBuckBunny.mp4" \
      -vf scale=1280:720 -c:v libx264 -preset fast -crf 23 -an \
      "$VIDEO_DIR/bbb_720p.mp4"
  fi
  
  if [ ! -f "$VIDEO_DIR/bbb_480p.mp4" ]; then
    echo "  Creating 480p variant..."
    ffmpeg -hide_banner -loglevel warning \
      -i "$VIDEO_DIR/BigBuckBunny.mp4" \
      -vf scale=854:480 -c:v libx264 -preset fast -crf 23 -an \
      "$VIDEO_DIR/bbb_480p.mp4"
  fi
else
  echo "  FFmpeg not found — skipping resolution variants."
  echo "  Install FFmpeg for multi-resolution testing."
fi

# 3. Start Docker
echo ""
echo "Step 3: Starting Docker environment..."

if command -v docker &> /dev/null; then
  docker compose -f docker/docker-compose.yml up -d
  echo "  MediaMTX started. Waiting for ready..."
  sleep 3
  
  # Verify
  if curl -s http://localhost:9997/v3/paths/list > /dev/null 2>&1; then
    echo "  MediaMTX API responding ✓"
  else
    echo "  WARNING: MediaMTX API not responding yet. It may need more time."
  fi
else
  echo "  Docker not found — skipping Docker setup."
  echo "  Install Docker to run the RTSP server."
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start RTSP streams:  ./scripts/generate-streams.sh 4"
echo "  2. Start bridge server: npm run bridge"
echo "  3. Start client:        npm run dev"
echo "  4. Open browser:        http://localhost:5173"
```

## Bridge Server Protocol Detail

The bridge server's WebSocket protocol is designed for minimal overhead:

### Connection Flow

1. Client connects to `ws://localhost:9000`
2. Server sends capabilities message (version 0xFF, JSON):
   ```json
   {
     "version": 1,
     "streams": [
       { "id": 1, "name": "stream1", "width": 1920, "height": 1080, "fps": 30 },
       { "id": 2, "name": "stream2", "width": 1920, "height": 1080, "fps": 30 }
     ]
   }
   ```
3. Client sends subscribe message (JSON text frame):
   ```json
   { "action": "subscribe", "streamIds": [1, 2, 3, 4] }
   ```
4. Server begins sending binary frames for subscribed streams
5. First frame per stream MUST contain SPS/PPS (flags bit 1 set)
6. First frame per stream MUST be a keyframe (flags bit 0 set)

### Unsubscribe

```json
{ "action": "unsubscribe", "streamIds": [3, 4] }
```

Server stops sending frames for those stream IDs.

### REST API

```
GET  /streams          — List available RTSP streams + metadata
POST /streams          — Add a new RTSP source: { "rtspUrl": "rtsp://..." }
DELETE /streams/:id    — Remove a stream
GET  /health           — Server health check
```

## Network Requirements

- **Bandwidth**: 1080p@30fps H.264 ≈ 4-8 Mbps per stream. 16 streams ≈ 64-128 Mbps.
  On localhost this is not an issue; for remote testing, ensure adequate network.
- **Latency**: localhost adds <1ms. The bridge server processes frames synchronously.
- **Ports**: 8554 (RTSP), 9000 (WebSocket), 9997 (MediaMTX API), 5173 (Vite dev server)

## Verifying the Test Environment

```bash
# Check MediaMTX is running
curl http://localhost:9997/v3/paths/list

# Expected output (after streams are started):
# {"items":[{"name":"stream1","source":{"type":"rtspSource",...}}, ...]}

# Test RTSP playback directly
ffplay -rtsp_transport tcp rtsp://localhost:8554/stream1

# Check bridge server health
curl http://localhost:9000/health

# Check available streams via bridge
curl http://localhost:9000/streams
```
