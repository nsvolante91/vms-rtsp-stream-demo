#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VIDEO_DIR="$PROJECT_DIR/test-videos"

mkdir -p "$VIDEO_DIR"

echo "=== Downloading test videos ==="

download_if_missing() {
  local url="$1"
  local dest="$2"
  if [ -f "$dest" ]; then
    echo "  Already exists: $(basename "$dest")"
  else
    echo "  Downloading: $(basename "$dest")..."
    curl -L -o "$dest" "$url"
  fi
}

download_if_missing \
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" \
  "$VIDEO_DIR/BigBuckBunny.mp4"

download_if_missing \
  "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4" \
  "$VIDEO_DIR/TearsOfSteel.mp4"

echo ""
echo "=== Generating resolution variants ==="

generate_variant() {
  local src="$1"
  local dest="$2"
  local scale="$3"
  if [ -f "$dest" ]; then
    echo "  Already exists: $(basename "$dest")"
  else
    echo "  Generating: $(basename "$dest")..."
    ffmpeg -y -i "$src" -vf "scale=$scale" -c:v libx264 -preset fast -crf 23 -an "$dest" 2>/dev/null
  fi
}

generate_variant "$VIDEO_DIR/BigBuckBunny.mp4" "$VIDEO_DIR/bbb_720p.mp4" "1280:720"
generate_variant "$VIDEO_DIR/BigBuckBunny.mp4" "$VIDEO_DIR/bbb_480p.mp4" "854:480"

echo ""
echo "=== Starting Docker environment ==="
docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" up -d

echo ""
echo "=== Waiting for MediaMTX to start ==="
sleep 3

echo ""
echo "=== Test environment ready ==="
echo "MediaMTX RTSP: rtsp://localhost:8554"
echo ""
echo "Run ./scripts/generate-streams.sh <N> to start N simulated camera streams"
