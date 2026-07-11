#!/usr/bin/env python3
"""Small checker for clinics.geojson.

This just gives a summary, looks for duplicate-ish names, and points out stuff
that looks missing or broken.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
import difflib
import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any

STATE_CODES = {"ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"}


def normalize_name(name: str) -> str:
    text = (name or "").lower().strip()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return " ".join(text.split())


def similar_ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def load_geojson(file_path: Path) -> dict[str, Any]:
    with file_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def looks_like_near_duplicate(a: str, b: str) -> bool:
    if not a or not b or a == b:
        return False

    ratio = similar_ratio(a, b)
    if ratio >= 0.92:
        return True

    # catches stuff like "hospital" vs "hospital dialysis unit"
    tokens_a = set(a.split())
    tokens_b = set(b.split())
    common = tokens_a.intersection(tokens_b)
    if common and min(len(tokens_a), len(tokens_b)) > 0:
        overlap = len(common) / min(len(tokens_a), len(tokens_b))
        if overlap >= 0.8 and ratio >= 0.82:
            return True

    return False


def audit_features(features: list[dict[str, Any]]) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    exact_name_dupes: dict[str, list[int]] = {}

    seen_by_name: dict[str, list[int]] = {}
    normalized_name_index: list[tuple[int, str]] = []

    for i, feature in enumerate(features):
        idx = i + 1

        if not isinstance(feature, dict):
            issues.append({"index": idx, "issue": "feature is not an object"})
            continue

        geometry = feature.get("geometry")
        properties = feature.get("properties")

        if not isinstance(properties, dict):
            issues.append({"index": idx, "issue": "missing or invalid properties object"})
            properties = {}

        if not isinstance(geometry, dict):
            issues.append({"index": idx, "issue": "missing or invalid geometry object"})
            geometry = {}

        name = str(properties.get("name", "")).strip()
        state = str(properties.get("state", "")).strip().upper()
        address = str(properties.get("address", "")).strip()
        phone = str(properties.get("phone", "")).strip()
        website = str(properties.get("website", "")).strip()

        if not name:
            issues.append({"index": idx, "issue": "missing clinic name"})

        if not address:
            issues.append({"index": idx, "issue": "missing address"})

        if state and state not in STATE_CODES:
            issues.append({"index": idx, "issue": f"invalid state code: {state}"})

        g_type = geometry.get("type")
        coords = geometry.get("coordinates")

        if g_type != "Point":
            issues.append({"index": idx, "issue": f"geometry type is not Point: {g_type}"})

        lon = lat = None
        if not isinstance(coords, list) or len(coords) != 2:
            issues.append({"index": idx, "issue": "coordinates missing or not [lon, lat]"})
        else:
            lon, lat = coords
            try:
                lon = float(lon)
                lat = float(lat)
            except (TypeError, ValueError):
                issues.append({"index": idx, "issue": "coordinates are not numeric"})
                lon = lat = None

            if lon is not None and not (-180 <= lon <= 180):
                issues.append({"index": idx, "issue": f"longitude out of range: {lon}"})
            if lat is not None and not (-90 <= lat <= 90):
                issues.append({"index": idx, "issue": f"latitude out of range: {lat}"})

        if phone and not re.search(r"\d", phone):
            issues.append({"index": idx, "issue": "phone present but has no digits"})

        if website and not re.match(r"^https?://", website, flags=re.IGNORECASE):
            issues.append({"index": idx, "issue": "website present but missing http/https"})

        n_name = normalize_name(name)
        if n_name:
            seen_by_name.setdefault(n_name, []).append(idx)
            normalized_name_index.append((idx, n_name))

    for n_name, idxs in seen_by_name.items():
        if len(idxs) > 1:
            exact_name_dupes[n_name] = idxs

    # only comparing the cleaned names once keeps the output a bit easier to read
    unique_names = sorted(seen_by_name.keys())
    near_dupe_pairs: list[dict[str, Any]] = []
    for a_i in range(len(unique_names)):
        for b_i in range(a_i + 1, len(unique_names)):
            a = unique_names[a_i]
            b = unique_names[b_i]
            if looks_like_near_duplicate(a, b):
                ratio = round(similar_ratio(a, b), 3)
                near_dupe_pairs.append(
                    {
                        "name_a": a,
                        "name_b": b,
                        "ratio": ratio,
                        "example_index_a": seen_by_name[a][0],
                        "example_index_b": seen_by_name[b][0],
                    }
                )

    near_dupe_pairs.sort(key=lambda x: x["ratio"], reverse=True)

    return {
        "total_features": len(features),
        "issue_count": len(issues),
        "issues": issues,
        "exact_name_dupe_count": len(exact_name_dupes),
        "exact_name_dupes": exact_name_dupes,
        "near_dupe_count": len(near_dupe_pairs),
        "near_dupes": near_dupe_pairs,
    }


def print_section(title: str) -> None:
    bar = "=" * len(title)
    print(f"\n{title}\n{bar}")


def print_command_invocation() -> None:
    cmd = " ".join(shlex.quote(part) for part in ["python3", *sys.argv])
    print(f"Running command: {cmd}")


def print_report(report: dict[str, Any], max_items: int) -> None:
    print_section("Clinics GeoJSON Audit")
    print(f"Total clinics                 : {report['total_features']}")
    print(f"Exact duplicate names         : {report['exact_name_dupe_count']}")
    print(f"Similar name pairs            : {report['near_dupe_count']}")
    print(f"Broken/missing entry issues   : {report['issue_count']}")

    if report["exact_name_dupes"]:
        print_section("Exact Duplicate Names (sample)")
        shown = 0
        for name, idxs in sorted(report["exact_name_dupes"].items(), key=lambda kv: (-len(kv[1]), kv[0])):
            print(f"- {name}")
            print(f"  feature indexes: {idxs}")
            shown += 1
            if shown >= max_items:
                break

    if report["near_dupes"]:
        print_section("Similar Name Pairs (sample)")
        for pair in report["near_dupes"][:max_items]:
            print(
                f"- ratio {pair['ratio']}: '{pair['name_a']}' [#{pair['example_index_a']}]"
                f" ~ '{pair['name_b']}' [#{pair['example_index_b']}]"
            )

    if report["issues"]:
        print_section("Broken or Missing Entries (sample)")
        for issue in report["issues"][:max_items]:
            print(f"- feature #{issue['index']}: {issue['issue']}")


def write_exports(report: dict[str, Any], output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    created: list[Path] = []

    summary_path = output_dir / f"clinic_audit_summary_{timestamp}.json"
    with summary_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write("\n")
    created.append(summary_path)

    exact_path = output_dir / f"clinic_audit_exact_duplicates_{timestamp}.csv"
    with exact_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["normalized_name", "feature_indexes", "count"])
        for name, idxs in sorted(report["exact_name_dupes"].items(), key=lambda kv: (-len(kv[1]), kv[0])):
            writer.writerow([name, "|".join(str(i) for i in idxs), len(idxs)])
    created.append(exact_path)

    near_path = output_dir / f"clinic_audit_similar_names_{timestamp}.csv"
    with near_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ratio",
            "name_a",
            "example_index_a",
            "name_b",
            "example_index_b",
        ])
        for pair in report["near_dupes"]:
            writer.writerow([
                pair["ratio"],
                pair["name_a"],
                pair["example_index_a"],
                pair["name_b"],
                pair["example_index_b"],
            ])
    created.append(near_path)

    issues_path = output_dir / f"clinic_audit_issues_{timestamp}.csv"
    with issues_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["feature_index", "issue"])
        for issue in report["issues"]:
            writer.writerow([issue["index"], issue["issue"]])
    created.append(issues_path)

    return created


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only auditor for clinics.geojson")
    parser.add_argument("--file", default="clinics.geojson", help="Path to GeoJSON file")
    parser.add_argument(
        "--max-items",
        type=int,
        default=20,
        help="Max rows to print in each sample section",
    )
    parser.add_argument(
        "--export-dir",
        default="audit_reports/exports/audit",
        help="Directory to write CSV/JSON audit exports (default: audit_reports)",
    )
    parser.add_argument(
        "--no-export",
        action="store_true",
        help="Skip writing export files and print report only",
    )
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        raise SystemExit(f"File not found: {file_path}")

    data = load_geojson(file_path)
    if data.get("type") != "FeatureCollection":
        print("Warning: top-level 'type' is not 'FeatureCollection'.")

    features = data.get("features")
    if not isinstance(features, list):
        raise SystemExit("Invalid GeoJSON: 'features' must be a list")

    report = audit_features(features)
    print_command_invocation()
    print_report(report, max_items=args.max_items)

    if not args.no_export:
        created_files = write_exports(report, Path(args.export_dir))
        print_section("Export Files")
        for file_path in created_files:
            print(f"- {file_path}")


if __name__ == "__main__":
    main()
