#!/usr/bin/env python3
"""Generate replica dashboard daily feed from Desktop Apple Health export."""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

DESKTOP_EXPORT_XML = Path.home() / "Desktop" / "apple_health_export" / "export.xml"
PROJECT_DIR = Path("/Users/saajan/AI_Projects")
OUTPUT_DAILY_CSV = PROJECT_DIR / "health_data_replica_daily.csv"

BODY_MASS = "HKQuantityTypeIdentifierBodyMass"
LEAN_MASS = "HKQuantityTypeIdentifierLeanBodyMass"
BODY_FAT_PCT = "HKQuantityTypeIdentifierBodyFatPercentage"
STEP_COUNT = "HKQuantityTypeIdentifierStepCount"
DIETARY_PROTEIN = "HKQuantityTypeIdentifierDietaryProtein"
DIETARY_CARBS = "HKQuantityTypeIdentifierDietaryCarbohydrates"
DIETARY_FAT = "HKQuantityTypeIdentifierDietaryFatTotal"
DIETARY_KCAL = "HKQuantityTypeIdentifierDietaryEnergyConsumed"
RESTING_HEART_RATE = "HKQuantityTypeIdentifierRestingHeartRate"


def to_date_key(datetime_str: str) -> str | None:
    if not datetime_str or len(datetime_str) < 10:
        return None
    return datetime_str[:10]


def normalize_value(record_type: str, unit: str, value: float) -> float | None:
    u = unit.lower().strip()
    if record_type in {BODY_MASS, LEAN_MASS}:
        if u == "kg":
            return value
        if u in {"lb", "lbs"}:
            return value * 0.45359237
        if u == "g":
            return value / 1000.0
        if u == "st":
            return value * 6.35029318
        return None
    if record_type == BODY_FAT_PCT:
        return value * 100.0 if value <= 1.0 else value
    if record_type == STEP_COUNT:
        return value
    if record_type in {DIETARY_PROTEIN, DIETARY_CARBS, DIETARY_FAT}:
        if u == "g":
            return value
        if u == "kg":
            return value * 1000.0
        return None
    if record_type == DIETARY_KCAL:
        if u == "kcal":
            return value
        if u == "cal":
            return value / 1000.0
        return None
    if record_type == RESTING_HEART_RATE:
        if u in {"count/min", "bpm", "/min"}:
            return value
        return None
    return None


def avg(values: list[float]) -> float | None:
    return (sum(values) / len(values)) if values else None


def parse_export(export_path: Path) -> list[dict[str, str]]:
    if not export_path.exists():
        raise FileNotFoundError(f"Apple Health export not found: {export_path}")

    per_day = defaultdict(
        lambda: {
            "weight": [],
            "lean": [],
            "bodyfat": [],
            "steps": [],
            "protein": [],
            "carbs": [],
            "fat": [],
            "kcal": [],
            "resting_hr": [],
            "training": False,
        }
    )

    tracked_types = {
        BODY_MASS,
        LEAN_MASS,
        BODY_FAT_PCT,
        STEP_COUNT,
        DIETARY_PROTEIN,
        DIETARY_CARBS,
        DIETARY_FAT,
        DIETARY_KCAL,
        RESTING_HEART_RATE,
    }

    # iterparse keeps memory bounded even on large export.xml.
    for _, elem in ET.iterparse(export_path, events=("end",)):
        if elem.tag == "Record":
            record_type = elem.attrib.get("type", "")
            if record_type in tracked_types:
                date_key = to_date_key(elem.attrib.get("startDate", ""))
                if date_key:
                    raw_value = elem.attrib.get("value")
                    unit = elem.attrib.get("unit", "")
                    if raw_value is not None:
                        try:
                            value = float(raw_value)
                        except ValueError:
                            value = None
                        if value is not None:
                            normalized = normalize_value(record_type, unit, value)
                            if normalized is not None:
                                bucket = per_day[date_key]
                                if record_type == BODY_MASS:
                                    bucket["weight"].append(normalized)
                                elif record_type == LEAN_MASS:
                                    bucket["lean"].append(normalized)
                                elif record_type == BODY_FAT_PCT:
                                    bucket["bodyfat"].append(normalized)
                                elif record_type == STEP_COUNT:
                                    bucket["steps"].append(normalized)
                                elif record_type == DIETARY_PROTEIN:
                                    bucket["protein"].append(normalized)
                                elif record_type == DIETARY_CARBS:
                                    bucket["carbs"].append(normalized)
                                elif record_type == DIETARY_FAT:
                                    bucket["fat"].append(normalized)
                                elif record_type == DIETARY_KCAL:
                                    bucket["kcal"].append(normalized)
                                elif record_type == RESTING_HEART_RATE:
                                    bucket["resting_hr"].append(normalized)
        elif elem.tag == "Workout":
            date_key = to_date_key(elem.attrib.get("startDate", ""))
            if date_key:
                per_day[date_key]["training"] = True

        elem.clear()

    rows: list[dict[str, str]] = []
    for day in sorted(per_day.keys()):
        bucket = per_day[day]
        rows.append(
            {
                "date": day,
                "weightKg": f"{avg(bucket['weight']):.4f}" if bucket["weight"] else "",
                "steps": f"{sum(bucket['steps']):.0f}" if bucket["steps"] else "",
                "proteinG": f"{sum(bucket['protein']):.2f}" if bucket["protein"] else "",
                "kcal": f"{sum(bucket['kcal']):.2f}" if bucket["kcal"] else "",
                "bodyFatPct": f"{avg(bucket['bodyfat']):.2f}" if bucket["bodyfat"] else "",
                "leanMassKg": f"{avg(bucket['lean']):.4f}" if bucket["lean"] else "",
                "trainingDay": "TRUE" if bucket["training"] else "FALSE",
                "carbsG": f"{sum(bucket['carbs']):.2f}" if bucket["carbs"] else "",
                "fatG": f"{sum(bucket['fat']):.2f}" if bucket["fat"] else "",
                "restingHr": f"{avg(bucket['resting_hr']):.1f}" if bucket["resting_hr"] else "",
            }
        )
    if not rows:
        return rows
    # Keep only the most recent 365 days for the dashboard feed.
    latest_day = rows[-1]["date"]
    latest_dt = datetime.fromisoformat(latest_day)
    min_dt = latest_dt - timedelta(days=365)
    rows = [r for r in rows if datetime.fromisoformat(r["date"]) >= min_dt]
    return rows


def write_csv(rows: list[dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "date",
        "weightKg",
        "steps",
        "proteinG",
        "kcal",
        "bodyFatPct",
        "leanMassKg",
        "trainingDay",
        "carbsG",
        "fatG",
        "restingHr",
    ]
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    rows = parse_export(DESKTOP_EXPORT_XML)
    write_csv(rows, OUTPUT_DAILY_CSV)
    print(f"Synced {len(rows)} days from {DESKTOP_EXPORT_XML}")
    print(f"Wrote {OUTPUT_DAILY_CSV}")


if __name__ == "__main__":
    main()
