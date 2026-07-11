"""Small helper to turn the clinic CSV files into one GeoJSON file.

It skips rows without coordinates and tries not to duplicate clinics that land
in the same spot with the same name.
"""

import csv
import json
from pathlib import Path

csv_files = [
    Path("data/dialysis_hospitals.csv"),
    Path("data/clinics.csv"),
]
geojson_file = Path("clinics.geojson")


def normalize(text):
    return " ".join(str(text or "").lower().replace("&", "and").split())


def make_properties(row):
    return {
        "name": row.get("name", "").strip(),
        "state": row.get("state", "").strip(),
        "service": (row.get("service", "") or row.get("serviceType", "")).strip(),
        "address": row.get("address", "").strip(),
        "phone": row.get("phone", "").strip(),
        "website": row.get("website", "").strip(),
        "wheelchair": row.get("wheelchair", "").strip(),
        "parking": row.get("parking", "").strip(),
        "source": row.get("source", "").strip(),
    }


features = []
seen_keys = set()

for csv_path in csv_files:
    if not csv_path.exists():
        print(f"Skipping missing source: {csv_path}")
        continue

    source_name = csv_path.name
    with csv_path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if not row.get("latitude", "").strip() or not row.get("longitude", "").strip():
                continue

            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
            except (ValueError, TypeError):
                continue

            name = row.get("name", "").strip()
            if not name:
                continue

            key = (normalize(name), round(lat, 6), round(lon, 6))
            if key in seen_keys:
                continue
            seen_keys.add(key)

            row["source"] = source_name
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat],
                },
                "properties": make_properties(row),
            }
            features.append(feature)

geojson = {"type": "FeatureCollection", "features": features}
with geojson_file.open("w", encoding="utf-8") as f:
    json.dump(geojson, f, indent=2)

print(f"Done! {len(features)} clinics written to {geojson_file}")
