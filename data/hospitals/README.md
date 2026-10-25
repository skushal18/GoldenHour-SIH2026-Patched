# Bangalore Hospital Dataset

Curated list of hospitals in Bengaluru for seeding GoldenHour's hospital directory
(the set ambulance crews broadcast pre-alerts to, and hospitals accept incoming cases from).

## Files

- `bangalore_hospitals.csv` — same data, CSV format
- `bangalore_hospitals.json` — 93 records, each with an `id` (H001–H093) for use as a DB primary key

## Columns

| Column | Description |
|---|---|
| `id` | Simple sequential ID (JSON only) |
| `Hospital Name` | Official/common name |
| `Type` | `Government` or `Private` |
| `Zone` | Bengaluru zone (Central / North / South / East / West — some are on zone borders) |
| `Area` | Locality/neighborhood |
| `Address` | Street address as published by the hospital or a directory |
| `Phone` | Landline where available (many smaller govt facilities don't publish one) |
| `Category` | Specialty focus (Multi-specialty, Cardiac, Oncology, Women & Children, etc.) |
| `Notes` | Bed count, accreditation, or other relevant context |

## Scope & known limitations

- **28 government hospitals** — major state-run referral hospitals, BBMP referral hospitals,
  and specialty institutes (Victoria, Bowring, Vani Vilas, Kidwai, Jayadeva, NIMHANS, IGICH, etc.)
- **65 private hospitals** — major multi-specialty and specialty chains across all 5 zones
  plus Electronic City/Bommanahalli as its own dense corridor
- **Not included:** BBMP's ~140 primary health centres (PHCs/UPHCs) — these generally lack
  emergency/inpatient trauma capacity, so they weren't a fit for ambulance pre-alert routing.
  Can be added later from the official BBMP hospital list if the app needs them.
- **No coordinates yet** — addresses only. Geocode before using for map placement in the
  hospital dashboard.
- Phone numbers/addresses pulled from hospital websites and public directories (Sep 2026) —
  worth spot-checking the ones you plan to actually demo with before demo day.

## Compiled

September 2026, via web research (government hospital directories, BBMP referral hospital
records, and area-wise private hospital listings for Bengaluru).

---

## All-India directory (v6) — `india_hospitals.csv`

**29,844 hospitals across 36 states and UTs**, used by the backend to match
ambulances to hospitals and by the admin console to create hospital logins.

| | Count |
|---|---:|
| Hospitals | 29,844 |
| Location as listed in the source | 9,562 |
| Location from the hospital's PIN code (approximate) | 17,125 |
| Location from the district centre (PIN code implausible) | 2,857 |
| No usable location | 300 |
| Likely emergency-capable (heuristic) | 21,435 |

**Sources**

- [National Hospital Directory with Geo Code](https://www.data.gov.in/resource/national-hospital-directory-geo-code-and-additional-parameters-updated-till-last-month),
  Ministry of Health and Family Welfare / NIHFW, data.gov.in, Government Open
  Data Licence – India. 30,273 rows; the file used has SHA-256
  `1ddcad9f9b922142a4374c7b89b70fb6cefd8a257448c70a61e1c07d98845134`.
- India Post pincode directory (Department of Posts, open government data) for
  PIN-code centres, via the `IndiaPIN` package's `pincode.csv`.
- `bangalore_hospitals.json` above: 15 matched and enriched, 78 added.

**How it is built** — `build_india_directory.py` (Python 3, standard library):

```bash
python3 data/hospitals/build_india_directory.py \
  hospital_directory.csv pincode.csv data/hospitals/bangalore_hospitals.json data/hospitals
```

- Placeholder `0` / `NA` values become blank; escaped newlines are removed.
- Coordinates outside India are dropped (swapped lat/lng are repaired). A listed
  point more than 60 km from its own PIN code's centre is replaced by the centre.
- Missing coordinates are filled from the PIN-code centre (the median of its post
  offices) and marked `coord_source = pincode`.
- India Post coordinates are wrong for some PIN codes, so every PIN-code
  placement is checked against its district (the median of the district's
  listed hospitals): more than 35 km away → the district centre is used and
  marked `coord_source = district`. When a listed point and its PIN code
  disagree by over 60 km, whichever agrees with the district wins.
- Exact duplicates (same name and PIN code) are merged: 507.
- Personal contact fields (nodal officer names, emails, registration scans) are
  **not** copied.
- `id` is the government serial number (`Sr_No`), so it never changes on a
  rebuild — hospital logins point at it. Curated additions use 100000+.
- `emergency_likely` is a name/type heuristic (hospital, medical college, CHC,
  trauma…; not eye/dental/clinic/AYUSH-only). It is a hint for ordering, not a
  verified capability.

**Limits** — the source dates from 2017 with later metadata updates; hospitals
open, close and move. PIN-code locations can be several kilometres out (the UI
marks them ≈). Verify a hospital before giving it a login.
