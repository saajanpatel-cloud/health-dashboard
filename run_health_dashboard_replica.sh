#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/Users/saajan/AI_Projects"

cd "$PROJECT_DIR"

echo "Syncing Desktop Apple Health export..."
python3 "$PROJECT_DIR/sync_apple_health_desktop.py"

echo "Starting local server..."
echo "Open: http://127.0.0.1:8000/health_dashboard_replica.html"
python3 "$PROJECT_DIR/health_dashboard_server.py"
