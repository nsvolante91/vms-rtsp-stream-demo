#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VIDEO_DIR="$PROJECT_DIR/test-videos"

NUM_STREAMS="${1:-4}"
RTSP_HOST="${2:-localhost}"
RTSP_PORT="${3:-8554}"

# Available source videos (cycle through them)
VIDEOS=()
for f in "$VIDEO_DIR"/*.mp4; do
  [ -f "$f" ] && VIDEOS+=("$f")
done

if [ ${#VIDEOS[@]} -eq 0 ]; then
  echo "ERROR: No test videos found in $VIDEO_DIR"
  echo "Run ./scripts/setup-test-env.sh first"
  exit 1
fi

echo "=== Starting $NUM_STREAMS simulated camera streams ==="
echo "Source videos: ${#VIDEOS[@]} available"
echo ""

# Kill any existing ffmpeg stream processes
pkill -f "ffmpeg.*rtsp://.*stream" 2>/dev/null || true
sleep 1

PIDS=()

for i in $(seq 1 "$NUM_STREAMS"); do
  # Cycle through available videos
  VIDEO_IDX=$(( (i - 1) % ${#VIDEOS[@]} ))
  VIDEO="${VIDEOS[$VIDEO_IDX]}"
  STREAM_NAME="stream${i}"
  RTSP_URL="rtsp://${RTSP_HOST}:${RTSP_PORT}/${STREAM_NAME}"

  echo "  Stream $i: $(basename "$VIDEO") → $RTSP_URL"

  ffmpeg \
    -re \
    -stream_loop -1 \
    -i "$VIDEO" \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -b:v 2M \
    -maxrate 2M \
    -bufsize 1M \
    -g 30 \
    -an \
    -f rtsp \
    -rtsp_transport tcp \
    "$RTSP_URL" \
    </dev/null >/dev/null 2>&1 &

  PIDS+=($!)
  sleep 0.5
done

echo ""
echo "=== $NUM_STREAMS streams running ==="
echo "PIDs: ${PIDS[*]}"
echo ""
echo "To stop: pkill -f 'ffmpeg.*rtsp.*stream'"
echo ""
echo "Verify with: ffprobe -rtsp_transport tcp rtsp://localhost:8554/stream1"

# Write PID file for cleanup
printf "%s\n" "${PIDS[@]}" > "$PROJECT_DIR/.stream-pids"
