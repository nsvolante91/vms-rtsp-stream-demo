#!/usr/bin/env bash
set -euo pipefail

echo "=== VMS Benchmark Runner ==="
echo ""
echo "Prerequisites:"
echo "  1. Docker running with MediaMTX (docker compose -f docker/docker-compose.yml up -d)"
echo "  2. Test streams active (./scripts/generate-streams.sh 16)"
echo "  3. Bridge server running (npm run bridge)"
echo "  4. Open http://localhost:5173 in Chrome 113+"
echo "  5. Click 'Run Benchmark' in the UI"
echo ""
echo "Starting client dev server..."
npm run dev
