#!/usr/bin/env bash
# Copy root web dashboard + sample CSV into the iOS app bundle folder after editing repo-root files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/ios/HealthDashboard/HealthDashboard"
for f in health_dashboard_replica.html health_dashboard_replica.css health_dashboard_replica.js health_data_replica_daily.csv; do
  cp -f "$ROOT/$f" "$DEST/$f"
done
echo "Synced $DEST from $ROOT"
