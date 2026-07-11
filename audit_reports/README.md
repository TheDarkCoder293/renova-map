Clinic Review Page

This folder is just for the clinic review page I made.

Main files in here:
- index.html
- reviewer.css
- reviewer.js

Export folders:
- exports/audit/
- exports/dedupe/

If you want to host it:
1. Upload the whole `audit_reports/` folder.
2. Keep `clinics.geojson` in the main project folder if you want the page to load it automatically.
3. Open `/audit_reports/` on your site.

If you want to test it locally:
1. Go to the main project folder.
2. Run `python3 -m http.server 5500`
3. Open `http://localhost:5500/audit_reports/`

What the buttons save:
1. `Quicksave` saves basically the whole session.
2. `Download my choices` saves the choices and merge changes.
3. `Download cleaned clinic file` saves a cleaned copy of the geojson.

Notes:
1. The map at the top is just for checking where things are.
2. Removed clinics disappear from that map on purpose.
3. Blue means I was not sure yet and marked it as needs research.