#!/usr/bin/env python3
"""Pick the 100 hospitals GoldenHour's RDS `hospitals` table starts with.

Reads india_hospitals.csv and writes network_hospitals.csv (the ids, in
order, with the city each was picked for). The backend seed script
(backend/scripts/seed-hospitals.js) loads exactly those ids into RDS.

Rules: emergency-capable (emergency_likely = 1) only; prefer coordinates as
listed in the source, then a phone number, then the curated Bengaluru list
and larger institutions; skip clinics, eye/dental/maternity-only and AYUSH
units. A fixed set of hospitals is always included.

The national directory has no Delhi rows, so the 100 are split across the
six remaining cities.

Deterministic: run it again on the same CSV and you get the same file.
"""
import csv
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'india_hospitals.csv')
OUT = os.path.join(HERE, 'network_hospitals.csv')

ALWAYS = [12179, 12815, 11880, 100093]
CITIES = [  # (label, predicate, quota)
    ('Bengaluru', lambda r: r['district'] == 'Bengaluru Urban', 17),
    ('Mumbai', lambda r: r['district'] == 'Mumbai', 17),
    ('Chennai', lambda r: r['district'] == 'Chennai', 17),
    # Older source rows file Hyderabad under Andhra Pradesh (pre-2014); same city.
    ('Hyderabad', lambda r: r['district'] == 'Hyderabad' and r['state'] in ('Telangana', 'Andhra Pradesh'), 17),
    ('Kolkata', lambda r: r['district'] == 'Kolkata', 16),
    ('Pune', lambda r: r['district'] == 'Pune', 16),
]
SKIP = re.compile(r'\b(clinic|eye|dental|maternity|nursing home|ayurved\w*|homoeo\w*|homeo\w*|unani|siddha|'
                  r'diagnostic|polyclinic|dispensary|skin|ent\b|ivf|fertility|physiotherapy|de-?addiction|psychiatr\w*)', re.I)
BIG = re.compile(r'(medical college|institute|general hospital|government|district hospital|multi|super ?speciality|'
                 r'apollo|fortis|manipal|narayana|aster|kims|care hospital|yashoda|max |columbia|sakra|kokilaben|'
                 r'lilavati|hinduja|jaslok|breach candy|tata memorial|kem|sion|nair|ruby hall|sahyadri|jehangir|'
                 r'deenanath|sassoon|amri|medica|peerless|ruby general|belle vue|woodlands|ssk|sskm|osmania|nims|'
                 r'gandhi|stanley|rajiv gandhi|kilpauk|vijaya|miot|sims|global|gleneagles|kauvery|billroth)', re.I)
LOC = {'listed': 3, 'pincode': 1, 'district': 0}


def name_key(name):
    return re.sub(r'\W+', '', name.lower())


STOP = {'the', 'dr', 'sri', 'shri', 'st'}


def stem(name):
    """First two significant words: 'Jaslok Hospital And Medical...' -> 'jaslok hospital'."""
    words = [w for w in re.split(r'[^a-z0-9]+', name.lower()) if w and w not in STOP]
    return ' '.join(words[:2])


def score(r):
    s = LOC.get(r['coord_source'], -5)
    s += 2 if r['phone'].strip() else 0
    s += 2 if r['curated'] == '1' else 0
    s += 1.5 if BIG.search(r['name']) else 0
    if r['beds']:
        try:
            s += min(float(r['beds']) / 200, 2)
        except ValueError:
            pass
    return s


def main():
    with open(SOURCE, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    by_id = {int(r['id']): r for r in rows}
    chosen = []
    seen = set()
    for label, pred, quota in CITIES:
        picked = [by_id[i] for i in ALWAYS if pred(by_id[i])]
        names = {name_key(p['name']) for p in picked}
        stems = {stem(p['name']): p['phone'].strip() for p in picked}
        pool = [r for r in rows if pred(r) and r['emergency_likely'] == '1' and r['lat'] and r['lng']
                and not SKIP.search(r['name']) and int(r['id']) not in ALWAYS]
        pool.sort(key=lambda r: (-score(r), r['name'].lower(), int(r['id'])))
        for r in pool:
            if len(picked) >= quota:
                break
            # The source lists some hospitals twice, under slightly different names.
            key, st, ph = name_key(r['name']), stem(r['name']), r['phone'].strip()
            if key in names or (st in stems and (not ph or not stems[st] or ph == stems[st])):
                continue
            names.add(key)
            stems.setdefault(st, ph)
            picked.append(r)
        for r in picked:
            if int(r['id']) not in seen:
                seen.add(int(r['id']))
                chosen.append((label, r))
    with open(OUT, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['id', 'city', 'name', 'coord_source', 'phone'])
        for label, r in chosen:
            w.writerow([r['id'], label, r['name'], r['coord_source'], r['phone']])
    print('wrote %d hospitals to %s' % (len(chosen), os.path.relpath(OUT)))


if __name__ == '__main__':
    main()
