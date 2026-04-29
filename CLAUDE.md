# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Dashboard

```bash
# Sync data + start local server in one step
./run_health_dashboard_replica.sh

# Or separately:
python3 sync_apple_health_desktop.py        # parse Apple Health export → CSV
python3 health_dashboard_server.py          # serve on http://127.0.0.1:8000
```

Open: `http://127.0.0.1:8000/health_dashboard_replica.html`

No build step. No dependencies beyond Python 3 stdlib.

## Architecture

**Data flow:**
1. `~/Desktop/apple_health_export/export.xml` (Apple Health XML export, not committed)
2. `sync_apple_health_desktop.py` — streams the XML with `ET.iterparse`, aggregates records by calendar day, normalises units to kg/g/kcal, emits the last 365 days as `health_data_replica_daily.csv`
3. `health_dashboard_server.py` — `SimpleHTTPRequestHandler` serving static files; `POST /api/refresh` re-runs the sync script as a subprocess and returns JSON
4. `health_dashboard_replica.{html,css,js}` — vanilla JS SPA; **Overview** (6-month table, last 6 weeks aggregates, weekly drill-down) and **Targets** (macros, goals, maintenance kcal, achievability + rough calorie-to-goal copy)

**Frontend state:**
- `dailyRows` — parsed CSV rows, filtered to last 365 days
- `targets` / `prefs` — persisted in `localStorage` under keys `replica_targets` / `replica_prefs` (`prefs.activeTab` is `overview` or `targets`)
- `render()` rebuilds monthly, last-six-weeks, weekly tables and achievability from `dailyRows` + `targets`

**CSV schema** (`health_data_replica_daily.csv`):
`date, weightKg, steps, proteinG, kcal, bodyFatPct, leanMassKg, trainingDay, carbsG, fatG, restingHr`

All weight fields are stored in **kg**; the JS converts to lb for display when the user selects that unit. Energy is stored in **kcal**; converted to kJ on display.

**Averages (logged days):** weekly/monthly means for **weight** and **lean mass** use only values `> 0` kg; **body fat** uses `0 < pct < 100`; **protein** and **kcal daily averages** for weekly summaries exclude zeros (treated as not logged). **Steps** remain a **week sum**. **Weekly kcal remaining** uses **sum of daily kcal** for the week vs `7 ×` macro kcal target.

**Goal progress bars:** steps and protein use **higher-is-better** fill (100% at or above target). Weight and body fat use **distance-to-goal** toward the global targets.

**Targets calorie hint:** optional `maintenanceKcal` (kcal/day) plus weight goal and weeks; implied average daily surplus/deficit uses **~7700 kcal per kg** ÷ 7 as a rough rule of thumb (shown in UI with disclaimer). **Prefill from logs** sets maintenance from the mean of logged dietary kcal over the last **28** days (needs ≥7 logged days).

**Resting HR column:** shown only if the last **183 days** include enough valid `restingHr` samples (see `metricGateLastSixMonths` in JS).

## Key constraints

- Hardcoded paths: `sync_apple_health_desktop.py` reads from `~/Desktop/apple_health_export/export.xml` and writes to `/Users/saajan/AI_Projects/health_data_replica_daily.csv`. Update both `PROJECT_DIR` constants if the repo moves.
- The server must be running for the "Refresh Data" button to work (it calls `POST /api/refresh`). Opening `health_dashboard_replica.html` directly from the filesystem will load existing CSV data but refresh will fail.
- `health_data_replica_daily.csv` is committed to the repo as a data snapshot. `ps_snapshot.txt` is gitignored.
