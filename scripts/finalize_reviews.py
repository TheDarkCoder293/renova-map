#!/usr/bin/env python3
"""
Build a final clinics GeoJSON from reviewer data in Supabase.

Outputs:
- data/final_clinics_from_reviews.geojson
- data/phoenix_decision_differences.json
- data/finalization_summary.json

Rules:
- Final decision per clinic is majority vote from clinic_reviews.decision.
- If tied, prefer keep when present, else research, else remove.
- Label/category is most common non-empty label.
- Home dialysis and Aboriginal support are majority booleans from merge_reviews
  meta rows (group_key like meta-<clinic_id>), using dedicated columns with
  JSON fallback.
- custom_tag is the most common non-empty customTag in meta rows.
- Field overrides (name/address/etc) come from the newest non-meta merge row
  per keep_clinic_id.
- A separate file lists clinics where Phoenix's decision differs from final.
"""

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


DECISION_PRIORITY = ["keep", "research", "remove"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Finalize review outputs from Supabase")
    parser.add_argument("--repo-root", default=".", help="Path to repository root")
    parser.add_argument("--input-geojson", default="clinics.geojson", help="Base clinics GeoJSON path (relative to repo root)")
    parser.add_argument("--out-geojson", default="data/final_clinics_from_reviews.geojson", help="Final GeoJSON output path")
    parser.add_argument("--out-phoenix-diff", default="data/phoenix_decision_differences.json", help="Phoenix differences output path")
    parser.add_argument("--out-phoenix-diff-csv", default="data/phoenix_decision_differences.csv", help="Phoenix differences CSV output path")
    parser.add_argument("--out-summary", default="data/finalization_summary.json", help="Summary output path")
    parser.add_argument("--phoenix-name", default="Phoenix", help="Reviewer name to compare against final decisions")
    parser.add_argument("--supabase-url", default=None, help="Supabase URL (optional, can use env/config)")
    parser.add_argument("--supabase-key", default=None, help="Supabase anon/service key (optional, can use env/config)")
    parser.add_argument("--insecure-skip-tls-verify", action="store_true", help="Skip TLS certificate verification for HTTPS requests")
    return parser.parse_args()


def load_supabase_config(repo_root: Path) -> Tuple[Optional[str], Optional[str]]:
    config_path = repo_root / "audit_reports" / "supabase-config.js"
    if not config_path.exists():
        return None, None

    text = config_path.read_text(encoding="utf-8")
    url_match = re.search(r'RENOVA_SUPABASE_URL\s*=\s*"([^"]+)"', text)
    key_match = re.search(r'RENOVA_SUPABASE_ANON_KEY\s*=\s*"([^"]+)"', text)
    url = url_match.group(1).strip() if url_match else None
    key = key_match.group(1).strip() if key_match else None
    return url, key


def resolve_supabase_credentials(args: argparse.Namespace, repo_root: Path) -> Tuple[str, str]:
    env_url = os.getenv("RENOVA_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    env_key = os.getenv("RENOVA_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")
    file_url, file_key = load_supabase_config(repo_root)

    url = args.supabase_url or env_url or file_url
    key = args.supabase_key or env_key or file_key

    if not url or not key:
        raise RuntimeError(
            "Missing Supabase credentials. Set --supabase-url/--supabase-key, "
            "or env vars, or audit_reports/supabase-config.js"
        )

    return url.rstrip("/"), key


def supabase_get_all(
    url: str,
    key: str,
    table: str,
    select: str,
    page_size: int = 1000,
    insecure_skip_tls_verify: bool = False,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0

    while True:
        query = urllib.parse.urlencode({
            "select": select,
            "limit": str(page_size),
            "offset": str(offset),
        })
        endpoint = f"{url}/rest/v1/{table}?{query}"
        req = urllib.request.Request(
            endpoint,
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
            },
            method="GET",
        )
        try:
            context = None
            if insecure_skip_tls_verify:
                context = ssl._create_unverified_context()
            with urllib.request.urlopen(req, timeout=30, context=context) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Supabase query failed for {table}: HTTP {exc.code} {body}") from exc

        if not payload:
            break

        rows.extend(payload)
        if len(payload) < page_size:
            break
        offset += page_size

    return rows


def normalize_decision(value: Any) -> Optional[str]:
    if value is None:
        return None
    d = str(value).strip().lower()
    if d in {"keep", "remove", "research"}:
        return d
    return None


def resolve_majority_decision(counter: Counter) -> str:
    if not counter:
        return "keep"

    max_count = max(counter.values())
    winners = [name for name, count in counter.items() if count == max_count]
    if len(winners) == 1:
        return winners[0]

    for preferred in DECISION_PRIORITY:
        if preferred in winners:
            return preferred
    return winners[0]


def most_common_non_empty(values: Iterable[Any]) -> Optional[str]:
    cleaned = [str(v).strip().lower() for v in values if v is not None and str(v).strip()]
    if not cleaned:
        return None
    counts = Counter(cleaned)
    return counts.most_common(1)[0][0]


def parse_meta_bool(row: Dict[str, Any], direct_key: str, json_key: str) -> Optional[bool]:
    if row.get(direct_key) is not None:
        return bool(row.get(direct_key))

    merged = row.get("merged_values") or {}
    if not isinstance(merged, dict):
        return None
    value = merged.get(json_key)
    if value is None:
        return None
    return bool(value)


def choose_latest_override(merge_rows: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    latest: Dict[int, Tuple[str, Dict[str, Any]]] = {}

    for row in merge_rows:
        group_key = str(row.get("group_key") or "")
        if group_key.startswith("meta-"):
            continue

        keep_id = row.get("keep_clinic_id")
        merged = row.get("merged_values")
        if not isinstance(keep_id, int) or not isinstance(merged, dict) or not merged:
            continue

        updated_at = str(row.get("updated_at") or "")
        prev = latest.get(keep_id)
        if prev is None or updated_at >= prev[0]:
            latest[keep_id] = (updated_at, merged)

    return {k: v[1] for k, v in latest.items()}


def apply_override(feature: Dict[str, Any], merged: Dict[str, Any]) -> None:
    props = feature.setdefault("properties", {})

    for field in ["name", "address", "state", "phone", "website", "service", "source"]:
        if field in merged and merged[field] is not None:
            props[field] = merged[field]

    lon = merged.get("lon")
    lat = merged.get("lat")
    if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
        geom = feature.setdefault("geometry", {"type": "Point", "coordinates": [None, None]})
        geom["coordinates"] = [float(lon), float(lat)]


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()

    input_geojson_path = (repo_root / args.input_geojson).resolve()
    out_geojson_path = (repo_root / args.out_geojson).resolve()
    out_phoenix_path = (repo_root / args.out_phoenix_diff).resolve()
    out_phoenix_csv_path = (repo_root / args.out_phoenix_diff_csv).resolve()
    out_summary_path = (repo_root / args.out_summary).resolve()

    if not input_geojson_path.exists():
        raise RuntimeError(f"Input GeoJSON not found: {input_geojson_path}")

    url, key = resolve_supabase_credentials(args, repo_root)

    clinic_rows = supabase_get_all(
        url,
        key,
        "clinic_reviews",
        "clinic_id,reviewer_name,decision,label,updated_at",
        insecure_skip_tls_verify=args.insecure_skip_tls_verify,
    )
    try:
        merge_rows = supabase_get_all(
            url,
            key,
            "merge_reviews",
            "group_key,reviewer_name,keep_clinic_id,field_sources,merged_values,home_dialysis_program,aboriginal_support,updated_at",
            insecure_skip_tls_verify=args.insecure_skip_tls_verify,
        )
    except RuntimeError as exc:
        message = str(exc).lower()
        if "home_dialysis_program" not in message and "aboriginal_support" not in message:
            raise
        merge_rows = supabase_get_all(
            url,
            key,
            "merge_reviews",
            "group_key,reviewer_name,keep_clinic_id,field_sources,merged_values,updated_at",
            insecure_skip_tls_verify=args.insecure_skip_tls_verify,
        )

    with input_geojson_path.open("r", encoding="utf-8") as fh:
        base_geojson = json.load(fh)

    features = base_geojson.get("features") or []

    decision_votes: Dict[int, Counter] = defaultdict(Counter)
    label_votes: Dict[int, Counter] = defaultdict(Counter)
    reviewers_by_clinic: Dict[int, set] = defaultdict(set)
    phoenix_vote: Dict[int, str] = {}

    phoenix_lower = args.phoenix_name.strip().lower()

    for row in clinic_rows:
        clinic_id = row.get("clinic_id")
        if not isinstance(clinic_id, int):
            continue

        reviewer = str(row.get("reviewer_name") or "").strip()
        if reviewer:
            reviewers_by_clinic[clinic_id].add(reviewer)

        decision = normalize_decision(row.get("decision"))
        if decision:
            decision_votes[clinic_id][decision] += 1
            if reviewer.lower() == phoenix_lower:
                phoenix_vote[clinic_id] = decision

        label = row.get("label")
        if label is not None and str(label).strip():
            label_votes[clinic_id][str(label).strip().lower()] += 1

    meta_rows = [row for row in merge_rows if str(row.get("group_key") or "").startswith("meta-")]
    override_by_clinic = choose_latest_override(merge_rows)

    home_votes: Dict[int, Counter] = defaultdict(Counter)
    aboriginal_votes: Dict[int, Counter] = defaultdict(Counter)
    custom_tag_values: Dict[int, List[str]] = defaultdict(list)

    for row in meta_rows:
        clinic_id = row.get("keep_clinic_id")
        if not isinstance(clinic_id, int):
            continue

        home_value = parse_meta_bool(row, "home_dialysis_program", "homeDialysisProgram")
        if home_value is not None:
            home_votes[clinic_id]["true" if home_value else "false"] += 1

        aboriginal_value = parse_meta_bool(row, "aboriginal_support", "aboriginalSupport")
        if aboriginal_value is not None:
            aboriginal_votes[clinic_id]["true" if aboriginal_value else "false"] += 1

        merged = row.get("merged_values") or {}
        if isinstance(merged, dict):
            custom = merged.get("customTag")
            if custom is not None and str(custom).strip():
                custom_tag_values[clinic_id].append(str(custom).strip().lower())

    final_decisions: Dict[int, str] = {}
    phoenix_differences: List[Dict[str, Any]] = []

    finalized_features: List[Dict[str, Any]] = []
    removed_count = 0

    for idx, feature in enumerate(features, start=1):
        decision_counter = decision_votes.get(idx, Counter())
        final_decision = resolve_majority_decision(decision_counter)
        final_decisions[idx] = final_decision

        if final_decision == "remove":
            removed_count += 1
            continue

        out = copy.deepcopy(feature)
        props = out.setdefault("properties", {})

        if label_votes.get(idx):
            props["category"] = label_votes[idx].most_common(1)[0][0]

        custom_tag = most_common_non_empty(custom_tag_values.get(idx, []))
        if custom_tag:
            props["custom_tag"] = custom_tag
        else:
            props.pop("custom_tag", None)

        home_counter = home_votes.get(idx, Counter())
        if home_counter:
            home_true = home_counter.get("true", 0)
            home_false = home_counter.get("false", 0)
            if home_true > home_false:
                props["home_dialysis_program"] = True
            elif home_false >= home_true:
                props.pop("home_dialysis_program", None)

        aboriginal_counter = aboriginal_votes.get(idx, Counter())
        if aboriginal_counter:
            ab_true = aboriginal_counter.get("true", 0)
            ab_false = aboriginal_counter.get("false", 0)
            if ab_true > ab_false:
                props["aboriginal_support"] = True
            elif ab_false >= ab_true:
                props.pop("aboriginal_support", None)

        override = override_by_clinic.get(idx)
        if override:
            apply_override(out, override)

        finalized_features.append(out)

        p_vote = phoenix_vote.get(idx)
        if p_vote and p_vote != final_decision:
            other_reviewers = [
                name for name in sorted(reviewers_by_clinic.get(idx, set()))
                if name.strip().lower() != phoenix_lower
            ]
            if other_reviewers:
                phoenix_differences.append({
                    "clinic_id": idx,
                    "clinic_name": str(props.get("name") or ""),
                    "phoenix_decision": p_vote,
                    "final_decision": final_decision,
                    "decision_votes": {
                        "keep": int(decision_counter.get("keep", 0)),
                        "remove": int(decision_counter.get("remove", 0)),
                        "research": int(decision_counter.get("research", 0)),
                    },
                    "reviewers_considered": sorted(reviewers_by_clinic.get(idx, set())),
                })

    finalized_geojson = {
        **base_geojson,
        "features": finalized_features,
    }

    out_geojson_path.parent.mkdir(parents=True, exist_ok=True)
    out_phoenix_path.parent.mkdir(parents=True, exist_ok=True)
    out_phoenix_csv_path.parent.mkdir(parents=True, exist_ok=True)
    out_summary_path.parent.mkdir(parents=True, exist_ok=True)

    with out_geojson_path.open("w", encoding="utf-8") as fh:
        json.dump(finalized_geojson, fh, ensure_ascii=False, indent=2)

    with out_phoenix_path.open("w", encoding="utf-8") as fh:
        json.dump(
            {
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "phoenix_name": args.phoenix_name,
                "count": len(phoenix_differences),
                "items": phoenix_differences,
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )

    with out_phoenix_csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "clinic_id",
                "clinic_name",
                "phoenix_decision",
                "final_decision",
                "votes_keep",
                "votes_remove",
                "votes_research",
                "reviewers_considered",
            ],
        )
        writer.writeheader()
        for item in phoenix_differences:
            votes = item.get("decision_votes") or {}
            writer.writerow(
                {
                    "clinic_id": item.get("clinic_id"),
                    "clinic_name": item.get("clinic_name", ""),
                    "phoenix_decision": item.get("phoenix_decision", ""),
                    "final_decision": item.get("final_decision", ""),
                    "votes_keep": votes.get("keep", 0),
                    "votes_remove": votes.get("remove", 0),
                    "votes_research": votes.get("research", 0),
                    "reviewers_considered": "; ".join(item.get("reviewers_considered") or []),
                }
            )

    summary = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "input_geojson": str(input_geojson_path),
        "output_geojson": str(out_geojson_path),
        "output_phoenix_diff": str(out_phoenix_path),
        "output_phoenix_diff_csv": str(out_phoenix_csv_path),
        "reviewers_total_rows": len(clinic_rows),
        "merge_total_rows": len(merge_rows),
        "clinics_input": len(features),
        "clinics_output": len(finalized_features),
        "clinics_removed": removed_count,
        "phoenix_differences": len(phoenix_differences),
    }

    with out_summary_path.open("w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    print("Finalization complete")
    print(f"- Final GeoJSON: {out_geojson_path}")
    print(f"- Phoenix differences: {out_phoenix_path}")
    print(f"- Phoenix differences CSV: {out_phoenix_csv_path}")
    print(f"- Summary: {out_summary_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
