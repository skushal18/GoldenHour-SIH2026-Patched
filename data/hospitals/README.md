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
