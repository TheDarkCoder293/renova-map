"""Quick script for filling in one clinic at a time.

This is more of a rough helper than a proper pipeline.
"""

import os
from pathlib import Path
import urllib.parse

import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

TOKEN = (
    os.getenv("MAPBOX_TOKEN")
    or os.getenv("MAPBOX_API_TOKEN")
    or os.getenv("MAPBOX_ACCESS_TOKEN")
)

if TOKEN:
    print("Mapbox token loaded.")
else:
    print("No Mapbox token found; continuing without token.")

base_dir = Path(__file__).resolve().parent.parent
csv_candidates = [
    base_dir / "data" / "clinics.csv",
    base_dir / "data" / "Renova clinic database - clinics.csv",
]

csv_path = next((path for path in csv_candidates if path.exists()), None)

if csv_path is None:
    raise FileNotFoundError(f"Could not find a clinics CSV file in {base_dir / 'data'}")

df = pd.read_csv(csv_path, dtype=str).fillna("")

# make sure these columns exist first
for col in ("address", "longitude", "latitude"):
    if col not in df.columns:
        df[col] = ""

# keep address as text and try to coerce coords into numbers
df["address"] = df["address"].fillna("").astype(str)
df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")

print(f"Loaded {len(df)} clinics from {csv_path.name}")
print(f"Loaded {len(df)} clinics")

for index, clinic in df.iterrows():

    if clinic["status"] == "Verified":
        print(f"Skipping {clinic['name']} (already verified)")
        continue

    print(f"Processing {clinic['name']}")
    break

import re

print(df.columns.tolist())

clean_name = re.sub(
    r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b",
    " ",
    clinic["name"],
    flags=re.IGNORECASE,
).strip()

clean_name = " ".join(clean_name.split()) 

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
state_name = STATE_NAMES.get(clinic["state"])

query = f"{clean_name}, {state_name}, Australia"

print (query)

url = (
    "https://api.mapbox.com/search/geocode/v6/forward"
    f"?q={urllib.parse.quote(query)}"
    f"&access_token={TOKEN}"
)

response = requests.get(url)
print(response.status_code)

data = response.json()

if not data.get("features"):
    raise ValueError("No geocoding results found for the query")

for i, feature in enumerate(data["features"][:5]):
    print("\n------------------")
    print(i)
    print(feature["properties"]["name"])
    print(feature["properties"])

print("Name:", feature["properties"]["name"])
print("Address:", feature["properties"]["full_address"])
print("Longitude:", feature["geometry"]["coordinates"][0])
print("Latitude:", feature["geometry"]["coordinates"][1])

df.loc[index, "address"] = feature["properties"]["full_address"]
df.loc[index, "longitude"] = feature["geometry"]["coordinates"][0]
df.loc[index, "latitude"] = feature["geometry"]["coordinates"][1]

print(feature["properties"])

df.to_csv(csv_path, index=False)
print("Saved.")

print("CSV updated!")
