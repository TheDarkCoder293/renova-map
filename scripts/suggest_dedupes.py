#!/usr/bin/env python3
"""Small script I made to help plan duplicate cleanup.

It does not edit the geojson file. It just reads it and makes a review plan so
it is easier to work out what to keep.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime
import difflib
import json
import math
import re
import shlex
import sys
from pathlib import Path
from typing import Any


def normalize_name(name: str) -> str:
    text = (name or "").lower().strip()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return " ".join(text.split())


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def print_section(title: str) -> None:
    bar = "=" * len(title)
    print(f"\n{title}\n{bar}")


def print_command_invocation() -> None:
    cmd = " ".join(shlex.quote(part) for part in ["python3", *sys.argv])
    print(f"Running command: {cmd}")


def safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def completeness_score(properties: dict[str, Any]) -> int:
    score = 0
    for key in ("name", "address", "phone", "website", "state", "service"):
        if str(properties.get(key, "")).strip():
            score += 1
    return score


def feature_view(feature: dict[str, Any], index: int) -> dict[str, Any]:
    props = feature.get("properties", {}) if isinstance(feature, dict) else {}
    geom = feature.get("geometry", {}) if isinstance(feature, dict) else {}
    coords = geom.get("coordinates", []) if isinstance(geom, dict) else []

    lon = safe_float(coords[0]) if isinstance(coords, list) and len(coords) == 2 else None
    lat = safe_float(coords[1]) if isinstance(coords, list) and len(coords) == 2 else None

    return {
        "index": index,
        "name": str(props.get("name", "")).strip(),
        "normalized_name": normalize_name(str(props.get("name", "")).strip()),
        "address": str(props.get("address", "")).strip(),
        "state": str(props.get("state", "")).strip(),
        "phone": str(props.get("phone", "")).strip(),
        "website": str(props.get("website", "")).strip(),
        "source": str(props.get("source", "")).strip(),
        "service": str(props.get("service", "")).strip(),
        "lon": lon,
        "lat": lat,
        "completeness": completeness_score(props if isinstance(props, dict) else {}),
    }


def choose_keeper(entries: list[dict[str, Any]]) -> dict[str, Any]:
    # this is pretty basic but it usually works well enough
    return sorted(
        entries,
        key=lambda e: (
            e["completeness"],
            bool(e["website"]),
            bool(e["phone"]),
            -e["index"],
        ),
        reverse=True,
    )[0]


def build_exact_name_actions(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        if entry["normalized_name"]:
            grouped.setdefault(entry["normalized_name"], []).append(entry)

    actions: list[dict[str, Any]] = []
    for normalized_name, group in grouped.items():
        if len(group) < 2:
            continue
        keeper = choose_keeper(group)
        for entry in group:
            action = "keep" if entry["index"] == keeper["index"] else "remove_candidate"
            reason = (
                "best completeness in exact-name duplicate group"
                if action == "keep"
                else f"exact duplicate of feature #{keeper['index']}"
            )
            actions.append(
                {
                    "kind": "exact_name_duplicate",
                    "action": action,
                    "reason": reason,
                    "feature_index": entry["index"],
                    "name": entry["name"],
                    "normalized_name": normalized_name,
                    "keeper_index": keeper["index"],
                    "address": entry["address"],
                    "state": entry["state"],
                    "source": entry["source"],
                }
            )
    return sorted(actions, key=lambda a: (a["keeper_index"], a["feature_index"]))


def build_near_name_pairs(
    entries: list[dict[str, Any]], near_threshold: float, max_distance_km: float
) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    # doing this on the cleaned names first keeps the output less chaotic
    by_name: dict[str, dict[str, Any]] = {}
    for entry in entries:
        n = entry["normalized_name"]
        if n and n not in by_name:
            by_name[n] = entry

    names = sorted(by_name.keys())
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a_name = names[i]
            b_name = names[j]
            ratio = similarity(a_name, b_name)
            if ratio < near_threshold:
                continue

            a = by_name[a_name]
            b = by_name[b_name]

            distance = None
            if a["lon"] is not None and a["lat"] is not None and b["lon"] is not None and b["lat"] is not None:
                distance = haversine_km(a["lon"], a["lat"], b["lon"], b["lat"])

            if distance is not None and distance > max_distance_km:
                continue

            pairs.append(
                {
                    "kind": "near_name_duplicate",
                    "action": "review",
                    "reason": "similar names and nearby coordinates",
                    "ratio": round(ratio, 3),
                    "distance_km": round(distance, 3) if distance is not None else "",
                    "feature_index_a": a["index"],
                    "name_a": a["name"],
                    "address_a": a["address"],
                    "source_a": a["source"],
                    "feature_index_b": b["index"],
                    "name_b": b["name"],
                    "address_b": b["address"],
                    "source_b": b["source"],
                }
            )

    return sorted(pairs, key=lambda p: (p["ratio"], -float(p["distance_km"] or 0)), reverse=True)


def write_exports(
    output_dir: Path,
    exact_actions: list[dict[str, Any]],
    near_pairs: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    created: list[Path] = []

    json_path = output_dir / f"dedupe_plan_{ts}.json"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "metadata": metadata,
                "exact_name_actions": exact_actions,
                "near_name_review_pairs": near_pairs,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )
        f.write("\n")
    created.append(json_path)

    exact_csv = output_dir / f"dedupe_exact_name_actions_{ts}.csv"
    with exact_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "kind",
                "action",
                "reason",
                "feature_index",
                "name",
                "normalized_name",
                "keeper_index",
                "address",
                "state",
                "source",
            ]
        )
        for row in exact_actions:
            writer.writerow(
                [
                    row["kind"],
                    row["action"],
                    row["reason"],
                    row["feature_index"],
                    row["name"],
                    row["normalized_name"],
                    row["keeper_index"],
                    row["address"],
                    row["state"],
                    row["source"],
                ]
            )
    created.append(exact_csv)

    near_csv = output_dir / f"dedupe_near_name_review_pairs_{ts}.csv"
    with near_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "kind",
                "action",
                "reason",
                "ratio",
                "distance_km",
                "feature_index_a",
                "name_a",
                "address_a",
                "source_a",
                "feature_index_b",
                "name_b",
                "address_b",
                "source_b",
            ]
        )
        for row in near_pairs:
            writer.writerow(
                [
                    row["kind"],
                    row["action"],
                    row["reason"],
                    row["ratio"],
                    row["distance_km"],
                    row["feature_index_a"],
                    row["name_a"],
                    row["address_a"],
                    row["source_a"],
                    row["feature_index_b"],
                    row["name_b"],
                    row["address_b"],
                    row["source_b"],
                ]
            )
    created.append(near_csv)

    return created


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only dedupe planner for clinics.geojson")
    parser.add_argument("--file", default="clinics.geojson", help="Path to GeoJSON file")
    parser.add_argument("--export-dir", default="audit_reports/exports/dedupe", help="Directory for plan exports")
    parser.add_argument("--near-threshold", type=float, default=0.92, help="Name similarity threshold")
    parser.add_argument("--distance-km", type=float, default=5.0, help="Max km between near-duplicate candidates")
    parser.add_argument("--max-items", type=int, default=20, help="Max rows to print in each sample section")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        raise SystemExit(f"File not found: {file_path}")

    with file_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features")
    if not isinstance(features, list):
        raise SystemExit("Invalid GeoJSON: 'features' must be a list")

    entries = [feature_view(ft, i + 1) for i, ft in enumerate(features)]
    exact_actions = build_exact_name_actions(entries)
    near_pairs = build_near_name_pairs(entries, args.near_threshold, args.distance_km)

    exact_groups = len({row["normalized_name"] for row in exact_actions if row["action"] == "keep"})
    remove_candidates = sum(1 for row in exact_actions if row["action"] == "remove_candidate")

    print_command_invocation()
    print_section("Dedupe Plan Summary")
    print(f"Total clinics                          : {len(entries)}")
    print(f"Exact duplicate groups                : {exact_groups}")
    print(f"Exact-name remove candidates          : {remove_candidates}")
    print(f"Near-name review pairs                : {len(near_pairs)}")
    print(f"Near threshold                        : {args.near_threshold}")
    print(f"Near max distance (km)                : {args.distance_km}")

    if exact_actions:
        print_section("Exact-Name Suggestions (sample)")
        shown = 0
        for row in exact_actions:
            if row["action"] == "remove_candidate":
                print(
                    f"- REMOVE candidate #{row['feature_index']} ({row['name']})"
                    f" -> keep #{row['keeper_index']}"
                )
                shown += 1
                if shown >= args.max_items:
                    break

    if near_pairs:
        print_section("Near-Name Review Pairs (sample)")
        for row in near_pairs[: args.max_items]:
            print(
                f"- REVIEW ({row['ratio']}, {row['distance_km']} km):"
                f" #{row['feature_index_a']} '{row['name_a']}'"
                f" ~ #{row['feature_index_b']} '{row['name_b']}'"
            )

    metadata = {
        "input_file": str(file_path),
        "total_clinics": len(entries),
        "exact_duplicate_groups": exact_groups,
        "exact_remove_candidates": remove_candidates,
        "near_name_review_pairs": len(near_pairs),
        "near_threshold": args.near_threshold,
        "distance_km": args.distance_km,
        "read_only": True,
    }

    created = write_exports(Path(args.export_dir), exact_actions, near_pairs, metadata)
    print_section("Export Files")
    for path in created:
        print(f"- {path}")


if __name__ == "__main__":
    main()
