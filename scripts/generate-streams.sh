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

# Check if source video is already H.264 (can use stream copy instead of re-encoding)
is_h264() {
  local codec
  codec=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name -of csv=p=0 "$1" 2>/dev/null | head -1)
  [[ "$codec" == "h264" ]]
}

PIDS=()

for i in $(seq 1 "$NUM_STREAMS"); do
  # Cycle through available videos
  VIDEO_IDX=$(( (i - 1) % ${#VIDEOS[@]} ))
  VIDEO="${VIDEOS[$VIDEO_IDX]}"
  STREAM_NAME="stream${i}"
  RTSP_URL="rtsp://${RTSP_HOST}:${RTSP_PORT}/${STREAM_NAME}"

  if is_h264 "$VIDEO"; then
    # Source is already H.264 — stream copy (near-zero CPU, original quality)
    echo "  Stream $i: $(basename "$VIDEO") → $RTSP_URL  (passthrough, ~0% CPU)"

    ffmpeg \
      -re \
      -stream_loop -1 \
      -i "$VIDEO" \
      -c:v copy \
      -an \
      -f rtsp \
      -rtsp_transport tcp \
      "$RTSP_URL" \
      </dev/null >/dev/null 2>&1 &
  else
    # Non-H.264 source — must re-encode
    echo "  Stream $i: $(basename "$VIDEO") → $RTSP_URL  (re-encoding to H.264)"

    ffmpeg \
      -re \
      -stream_loop -1 \
      -i "$VIDEO" \
      -c:v libx264 \
      -preset ultrafast \
      -tune zerolatency \
      -crf 23 \
      -g 60 \
      -an \
      -f rtsp \
      -rtsp_transport tcp \
      "$RTSP_URL" \
      </dev/null >/dev/null 2>&1 &
  fi

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
