Renova

This project has 2 main parts:

1. The public clinic map
2. The clinic review page for checking duplicates and fixing entries

Main files in the repo root:

- index.html
- style.css
- script.js
- clinics.geojson

Folders:

- images/ = logo and image assets
- data/ = csv files and extra source data used while building the map
- scripts/ = helper scripts for geocoding, audits and dedupe planning
- audit_reports/ = the browser review tool

Public site pages:

1. Main map page:
   - /index.html
2. Review tool:
   - /audit_reports/index.html

If this gets hosted with GitHub Pages from the repo root:

1. The main map is the root page
2. The review page is at /audit_reports/

Useful files:

- data/locations_info.json = extra clinic source file used for import
- audit_reports/README.md = notes just for the review tool

Notes:

1. audit_reports/exports/ is ignored because it is generated output
2. .env is ignored because it is local only
3. clinics.geojson is the main data file the map uses

Finalize reviewer data:

1. Run `python3 scripts/finalize_reviews.py` from the repo root.
2. The script pulls `clinic_reviews` and `merge_reviews` from Supabase.
3. It writes:
   - `data/final_clinics_from_reviews.geojson`
   - `data/phoenix_decision_differences.json`
   - `data/phoenix_decision_differences.csv`
   - `data/finalization_summary.json`

Phoenix differences report:

1. `data/phoenix_decision_differences.json` lists clinics where reviewer `Phoenix` differs from the final majority decision.
2. The final output still uses the majority decision.
3. You can change the reviewer name with `--phoenix-name "<Reviewer Name>"`.