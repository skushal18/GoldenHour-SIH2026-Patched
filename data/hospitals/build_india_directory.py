"""Build GoldenHour's all-India hospital directory.

Inputs (passed as arguments, never imported from their folders):
  1. National Hospital Directory CSV (data.gov.in, NIHFW, GODL-India)
  2. India Post pincode directory CSV (Department of Posts, OGD)
  3. GoldenHour's curated Bengaluru list (data/hospitals/bangalore_hospitals.json)
Output dir: argument 4.
"""
import csv, json, math, re, sys, statistics, collections, os

nhd_path, pin_path, blr_path, out_dir = sys.argv[1:5]

def clean(v):
    if v is None: return ''
    s = str(v).replace('\\n', ' ').replace('\\r', ' ').replace('\\t', ' ')
    s = re.sub(r'\s+', ' ', s).strip(' ,;')
    return '' if s in ('0', 'NA', 'N/A', 'na', '-', 'null', 'NULL', 'Not Available') else s

def hav(a, b, c, d):
    R = 6371.0
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    x = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(x))

def in_india(lat, lng):
    return 6.0 <= lat <= 37.6 and 68.0 <= lng <= 97.5

# ── Pincode centroids: median of every post office in the PIN ──────────────
pins = collections.defaultdict(list)
with open(pin_path, encoding='utf-8', errors='replace') as f:
    for r in csv.DictReader(f):
        try:
            lat, lng = float(r['Latitude']), float(r['Longitude'])
        except (ValueError, TypeError):
            continue
        if not in_india(lat, lng):
            if in_india(lng, lat): lat, lng = lng, lat   # swapped columns are common
            else: continue
        pins[r['Pincode'].strip()].append((lat, lng))
pin_centroid = {}
for p, pts in pins.items():
    lat = statistics.median(x[0] for x in pts); lng = statistics.median(x[1] for x in pts)
    # drop outlier offices more than 40 km from the median, then re-median
    near = [x for x in pts if hav(lat, lng, x[0], x[1]) <= 40] or pts
    pin_centroid[p] = (round(statistics.median(x[0] for x in near), 6), round(statistics.median(x[1] for x in near), 6))

def title(s):
    if not s: return s
    if s.isupper() or s.islower():
        return ' '.join(w if w.isupper() and len(w) <= 4 else w.capitalize() for w in s.split(' '))
    return s

EMERGENCY_HINT = re.compile(r'hospital|medical college|institute of medical|trauma|nursing home|health centre|health center|chc|aiims|medical centre|medical center|infirmary|emergency', re.I)
NOT_EMERGENCY = re.compile(r'\b(eye|dental|dentist|optical|ayurved|homoeo|homeo|unani|siddha|naturopath|physiotherap|diagnostic|lab(oratory)?|scan|skin|hair|ivf|fertility|clinic|dispensary|de-?addiction|rehab)\b', re.I)

def phone(r):
    for k in ('Emergency_Num', 'Ambulance_Phone_No', 'Telephone', 'Helpline', 'Tollfree'):
        v = clean(r.get(k))
        if v and re.search(r'\d{6,}', re.sub(r'\D', '', v)):
            return v[:30]
    return ''

stats = collections.Counter()
seen = {}
out = []
with open(nhd_path, encoding='utf-8', errors='replace') as f:
    for r in csv.DictReader(f):
        stats['rows'] += 1
        name = clean(r['Hospital_Name'])
        if not name:
            stats['no_name'] += 1; continue
        state = title(clean(r['State'])); district = title(clean(r['District']))
        pincode = re.sub(r'\D', '', clean(r['Pincode']))[:6]
        pincode = pincode if len(pincode) == 6 else ''
        addr = clean(r['Address_Original_First_Line']) or clean(r['Location'])

        lat = lng = None; src = None
        raw = clean(r['Location_Coordinates'])
        m = re.findall(r'-?\d+\.\d+', raw)
        if len(m) >= 2:
            a, b = float(m[0]), float(m[1])
            if in_india(a, b): lat, lng = a, b
            elif in_india(b, a): lat, lng = b, a; stats['swapped'] += 1
        pc = pin_centroid.get(pincode)
        if lat is not None:
            if pc and hav(lat, lng, pc[0], pc[1]) > 60:
                # The listed point is far from its own pincode: trust the pincode.
                lat, lng = pc; src = 'pincode'; stats['gps_disagreed_used_pincode'] += 1
            else:
                src = 'listed'; stats['coords_listed'] += 1
        elif pc:
            lat, lng = pc; src = 'pincode'; stats['coords_pincode'] += 1
        else:
            stats['no_location'] += 1

        care = clean(r['Hospital_Care_Type']); cat = clean(r['Hospital_Category'])
        system = clean(r['Discipline_Systems_of_Medicine'])
        ownership = 'Government' if 'Gov' in cat else ('Private' if cat == 'Private' else '')
        emergency_listed = clean(r['Emergency_Services'])
        likely = bool(EMERGENCY_HINT.search(name) or care in ('Hospital', 'Community Health Centre', 'Medical College / Institute') or 'Hospital' in care) \
                 and not NOT_EMERGENCY.search(name) and not (system.startswith('Ayush') and 'Allopathic' not in system)
        if emergency_listed: likely = True

        key = (re.sub(r'[^a-z0-9]', '', name.lower()), pincode or district.lower())
        if key in seen:
            stats['duplicates'] += 1
            prev = seen[key]
            if prev['coord_source'] != 'listed' and src == 'listed':
                prev.update(lat=round(lat, 6), lng=round(lng, 6), coord_source='listed')
            continue
        rec = {
            'source_id': 'NHD-' + clean(r['Sr_No']),
            'name': title(name), 'state': state, 'district': district,
            'pincode': pincode, 'address': addr[:200],
            'phone': phone(r), 'ownership': ownership, 'care_type': care,
            'system': system, 'specialties': clean(r['Specialties'])[:300],
            'beds': int(clean(r['Total_Num_Beds'])) if clean(r['Total_Num_Beds']).isdigit() else None,
            'emergency_likely': likely,
            'lat': round(lat, 6) if lat is not None else None,
            'lng': round(lng, 6) if lng is not None else None,
            'coord_source': src,
        }
        seen[key] = rec
        out.append(rec)

# ── Bengaluru curated list: enrich matches, add the rest ────────────────────
blr = json.load(open(blr_path, encoding='utf-8'))
by_name = collections.defaultdict(list)
for rec in out:
    by_name[re.sub(r'[^a-z0-9]', '', rec['name'].lower())].append(rec)
added = enriched = 0
for h in blr:
    nm = h.get('Hospital Name') or h.get('name') or ''
    key = re.sub(r'[^a-z0-9]', '', nm.lower())
    pin = re.search(r'\b(5[0-9]{5})\b', h.get('Address', '') or '')
    pin = pin.group(1) if pin else ''
    hits = [x for x in by_name.get(key, []) if x['state'] == 'Karnataka']
    if hits:
        x = hits[0]; enriched += 1
        x['ownership'] = x['ownership'] or h.get('Type', '')
        x['phone'] = x['phone'] or (h.get('Phone') or '')
        x['emergency_likely'] = True
        x['curated'] = True
        continue
    pc = pin_centroid.get(pin)
    out.append({
        'source_id': 'BLR-' + str(h.get('id', '')), 'name': nm, 'state': 'Karnataka', 'district': 'Bengaluru Urban',
        'pincode': pin, 'address': (h.get('Address') or '')[:200], 'phone': h.get('Phone') or '',
        'ownership': h.get('Type') or '', 'care_type': 'Hospital', 'system': 'Allopathic',
        'specialties': h.get('Category') or '', 'beds': None, 'emergency_likely': True,
        'lat': pc[0] if pc else None, 'lng': pc[1] if pc else None,
        'coord_source': 'pincode' if pc else None, 'curated': True,
    })
    added += 1
stats['bangalore_enriched'] = enriched; stats['bangalore_added'] = added

out.sort(key=lambda r: (r['state'], r['district'], r['name']))
# Stable ids: hospital accounts point at these, so a rebuild must never renumber.
# National directory rows keep their government serial number; curated
# Bengaluru additions sit in their own range above 100000.
for r in out:
    sid = r['source_id']
    if sid.startswith('NHD-'):
        r['id'] = int(sid[4:])
    else:
        r['id'] = 100000 + int(re.sub(r'\D', '', sid) or 0)
assert len({r['id'] for r in out}) == len(out), 'hospital ids must be unique'

os.makedirs(out_dir, exist_ok=True)
cols = ['id', 'source_id', 'name', 'state', 'district', 'pincode', 'address', 'phone', 'ownership', 'care_type',
        'system', 'specialties', 'beds', 'emergency_likely', 'lat', 'lng', 'coord_source', 'curated']
with open(os.path.join(out_dir, 'india_hospitals.csv'), 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore'); w.writeheader()
    for r in out: w.writerow({**r, 'emergency_likely': int(bool(r['emergency_likely'])), 'curated': int(bool(r.get('curated')))})

summary = {
    'records': len(out),
    'with_location': sum(1 for r in out if r['lat'] is not None),
    'location_listed': sum(1 for r in out if r['coord_source'] == 'listed'),
    'location_pincode': sum(1 for r in out if r['coord_source'] == 'pincode'),
    'emergency_likely': sum(1 for r in out if r['emergency_likely']),
    'states': len(set(r['state'] for r in out)),
    'by_state': dict(collections.Counter(r['state'] for r in out).most_common()),
    'build_stats': dict(stats),
}
json.dump(summary, open(os.path.join(out_dir, 'india_hospitals.summary.json'), 'w'), indent=2)
print(json.dumps({k: v for k, v in summary.items() if k != 'by_state'}, indent=2))
