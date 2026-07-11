"""Looks up missing clinic details from Google Places.

I mostly used this for filling in gaps without having to redo the CSV by hand.
"""

import os
import re
import json
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv

# grab the API key from .env
base_dir = Path(__file__).resolve().parent.parent
load_dotenv(base_dir / ".env")
API_KEY = os.getenv("GOOGLE_API_KEY")

if not API_KEY:
    raise Exception("GOOGLE_API_KEY not found in .env")

# just using one source file here
csv_candidates = [
    base_dir / "data" / "dialysis_hospitals.csv",
]

csv_path = next((p for p in csv_candidates if p.exists()), None)

if csv_path is None:
    raise Exception("No clinics CSV found")

print(f"Using CSV: {csv_path}")

EXPORT_GEOJSON = base_dir / "clinics.geojson"

df = pd.read_csv(csv_path, dtype=str).fillna("")

# make sure the columns we want are there
for col in [
    "address",
    "state",
    "latitude",
    "longitude",
    "website",
    "phone",
    "dialysis_type",
    "haemodialysis",
    "peritoneal",
    "other",
]:
    if col not in df.columns:
        df[col] = ""

STATE_NAMES = {
    "ACT": "Australian Capital Territory",
    "NSW": "New South Wales",
    "NT": "Northern Territory",
    "QLD": "Queensland",
    "SA": "South Australia",
    "TAS": "Tasmania",
    "VIC": "Victoria",
    "WA": "Western Australia",
}

STATE_PATTERN = re.compile(r"\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b", re.IGNORECASE)


def infer_state(address):
    if not isinstance(address, str) or not address.strip():
        return ""
    match = STATE_PATTERN.search(address)
    return match.group(1).upper() if match else ""


def build_search_query(clinic):
    state_code = str(clinic.get("state", "")).strip().upper()
    if not state_code:
        state_code = infer_state(clinic.get("address", ""))
    state_name = STATE_NAMES.get(state_code, clinic.get("state", "").strip())
    query_parts = [str(clinic.get("name", "")).strip()]
    if state_name:
        query_parts.append(state_name)
    elif state_code:
        query_parts.append(state_code)
    if clinic.get("address", ""):
        query_parts.append(str(clinic["address"]).strip())
    query_parts.append("Australia")
    return ", ".join([part for part in query_parts if part])


def normalise(text):
    text = str(text or "").lower()
    text = text.replace("&", "and")
    text = re.sub(r"[^a-z0-9 ]", "", text)
    return " ".join(text.split())


def load_exported_clinic_names():
    if not EXPORT_GEOJSON.exists():
        return set()
    try:
        with EXPORT_GEOJSON.open(encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return set()

    names = set()
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        if not isinstance(props, dict):
            continue
        name = props.get("name", "")
        if name:
            names.add(normalise(name))
    return names


exported_clinic_names = load_exported_clinic_names()


# walk through rows and fill in the ones that still need data
for index, clinic in df.iterrows():
    if (
        str(clinic.get("website", "")).strip()
        and str(clinic.get("latitude", "")).strip()
        and str(clinic.get("longitude", "")).strip()
    ):
        continue

    query = build_search_query(clinic)

    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": (
            "places.id,"
            "places.displayName,"
            "places.formattedAddress,"
            "places.location,"
            "places.websiteUri,"
            "places.nationalPhoneNumber,"
            "places.types"
        ),
    }
    payload = {
        "textQuery": query,
        "includedType": "hospital"
    }

    response = requests.post(url, headers=headers, json=payload)
    print(f"{index}: {clinic.get('name', '')} -> {response.status_code}")

    try:
        data = response.json()
    except ValueError:
        print("❌ Invalid JSON response")
        continue

    if "places" not in data or not data["places"]:
        print(f"❌ No result for {clinic.get('name', '')}")
        continue

    places = data["places"]
    place = next((p for p in places if "hospital" in p.get("types", [])), places[0])

    print("\nTop Google results:\n")
    for i, candidate in enumerate(places[:5], start=1):
        print(f"{i}. {candidate['displayName']['text']}")
        print(candidate.get("formattedAddress", ""))
        print(candidate.get("types", []))
        print("-----------------------")

    clean_csv_name = re.sub(
        r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b",
        "",
        clinic.get("name", ""),
        flags=re.IGNORECASE,
    )
    clinic_name = normalise(clean_csv_name)
    google_name = normalise(place["displayName"]["text"])

    if clinic_name == google_name:
        print("✓ Auto accepted")
    else:
        print(f"\nCSV:    {clinic.get('name', '')}")
        print(f"Google: {place['displayName']['text']}")
        answer = input("Accept? (y/n): ").strip().lower()
        if answer != "y":
            print("Skipped.")
            continue

    df.loc[index, "address"] = str(place.get("formattedAddress", ""))
    df.loc[index, "phone"] = str(place.get("nationalPhoneNumber", ""))
    df.loc[index, "website"] = str(place.get("websiteUri", ""))
    df.loc[index, "latitude"] = str(place["location"].get("latitude", ""))
    df.loc[index, "longitude"] = str(place["location"].get("longitude", ""))

    df.to_csv(csv_path, index=False)
    print("Clinic updated.")
    print("-" * 40)
