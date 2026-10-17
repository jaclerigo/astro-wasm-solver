#!/usr/bin/env python3
"""Build the compact Messier/NGC/IC overlay catalog from OpenNGC CSV files."""

import argparse
import csv
import json
import math
import re
from pathlib import Path


DESIGNATION = re.compile(r"^(NGC|IC)\s*0*(\d+)", re.IGNORECASE)


def parse_angle(value, hours=False):
    value = value.strip()
    if not value:
        raise ValueError("empty coordinate")

    parts = value.split(":")
    if len(parts) == 1:
        angle = float(parts[0])
        return angle * 15.0 if hours else angle

    first = float(parts[0])
    minute = float(parts[1])
    second = float(parts[2]) if len(parts) > 2 else 0.0
    sign = -1.0 if not hours and value.startswith("-") else 1.0
    angle = abs(first) + minute / 60.0 + second / 3600.0
    return sign * angle * (15.0 if hours else 1.0)


def designation(row, field, name):
    value = row.get(field, "").strip()
    if value:
        digits = re.search(r"\d+", value)
        if digits:
            return int(digits.group())

    match = DESIGNATION.match(name.strip())
    if match and match.group(1).upper() == field:
        return int(match.group(2))
    return None


def convert_row(row):
    if row.get("Type", "").strip().lower() == "dup":
        return None

    messier_text = row.get("M", "").strip()
    messier = int(messier_text) if messier_text.isdigit() else None
    ngc = designation(row, "NGC", row.get("Name", ""))
    ic = designation(row, "IC", row.get("Name", ""))
    if messier is None and ngc is None and ic is None:
        return None

    labels = []
    if messier is not None:
        labels.append(f"M{messier}")
    if ngc is not None:
        labels.append(f"NGC {ngc}")
    if ic is not None:
        labels.append(f"IC {ic}")

    try:
        ra_deg = parse_angle(row.get("RA", ""), hours=True)
        dec_deg = parse_angle(row.get("Dec", ""))
    except ValueError:
        return None
    if not math.isfinite(ra_deg) or not math.isfinite(dec_deg):
        return None
    if not 0.0 <= ra_deg < 360.0 or not -90.0 <= dec_deg <= 90.0:
        return None

    return {
        "name": " / ".join(labels),
        "ra_deg": ra_deg,
        "dec_deg": dec_deg,
        "type": row.get("Type", "").strip(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_files", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("catalogs/openngc.json"))
    args = parser.parse_args()

    objects = {}
    for csv_path in args.csv_files:
        with csv_path.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source, delimiter=";"):
                obj = convert_row(row)
                if obj is not None:
                    objects[obj["name"]] = obj

    result = sorted(
        objects.values(), key=lambda obj: (obj["ra_deg"], obj["dec_deg"], obj["name"])
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Exported {len(result):,} objects to {args.output} ({args.output.stat().st_size:,} bytes).")


if __name__ == "__main__":
    main()
