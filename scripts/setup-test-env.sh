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

# 4K 60fps Big Buck Bunny (zip archive)
if [ -f "$VIDEO_DIR/bbb_sunflower_2160p_60fps_normal.mp4" ]; then
  echo "  Already exists: bbb_sunflower_2160p_60fps_normal.mp4"
else
  echo "  Downloading: bbb_sunflower_2160p_60fps_normal.mp4.zip..."
  curl -L -o "$VIDEO_DIR/bbb_sunflower_2160p_60fps_normal.mp4.zip" \
    "https://download.blender.org/demo/movies/BBB/bbb_sunflower_2160p_60fps_normal.mp4.zip"
  echo "  Extracting..."
  unzip -o "$VIDEO_DIR/bbb_sunflower_2160p_60fps_normal.mp4.zip" -d "$VIDEO_DIR"
  rm "$VIDEO_DIR/bbb_sunflower_2160p_60fps_normal.mp4.zip"
fi

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
if command -v docker &>/dev/null; then
  echo "=== Starting Docker environment ==="
  docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" up -d

  echo ""
  echo "=== Waiting for MediaMTX to start ==="
  sleep 3

  echo ""
  echo "=== Test environment ready ==="
  echo "MediaMTX RTSP: rtsp://localhost:8554"
else
  echo "=== Skipping Docker (not found in PATH) ==="
  echo "Install Docker or start MediaMTX manually to use RTSP streams."
fi

echo ""
echo "Run ./scripts/generate-streams.sh <N> to start N simulated camera streams"
