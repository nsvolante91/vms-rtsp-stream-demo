#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VIDEO_DIR="${VIDEO_DIR:-$PROJECT_DIR/test-videos}"

# Check for test videos
MP4_COUNT=$(find "$VIDEO_DIR" -maxdepth 1 -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ')

if [ "$MP4_COUNT" -eq 0 ]; then
  echo "ERROR: No .mp4 files found in $VIDEO_DIR"
  echo "Run ./scripts/setup-test-env.sh first to download test videos"
  exit 1
fi

echo "=== Starting bridge server in local file mode ==="
echo "Video directory: $VIDEO_DIR ($MP4_COUNT file(s))"
echo "No Docker or MediaMTX required."
echo ""

cd "$PROJECT_DIR"
SOURCE_MODE=local VIDEO_DIR="$VIDEO_DIR" npm run start -w bridge-server
