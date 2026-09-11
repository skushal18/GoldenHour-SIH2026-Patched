/* Local GPS plot: no map service receives patient or ambulance coordinates. */
export function trackingView(card, now = Date.now()) {
  const p = card.last_position;
  const valid = p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  const age = valid ? now - Date.parse(p.at) : Infinity;
  const stale = !Number.isFinite(age) || age > 30000 || age < -30000;
  const source = stale && valid ? 'stale' : (card.eta_source || 'crew');
  const live = valid && !stale && source === 'live' && Number.isFinite(card.live_eta_minutes);
  const crew = Number.isFinite(card.eta_minutes) ? card.eta_minutes + ' min (crew estimate)' : 'ETA unavailable';
  return { valid, source, stale, eta: live ? card.live_eta_minutes + ' min (GPS estimate)' : crew,
    label: ({ live: 'GPS ESTIMATE', crew: 'WAITING FOR GPS ETA', stationary: 'LOW SPEED · ETA UNCERTAIN', stalled: 'NOT MOVING · ETA UNCERTAIN', stale: 'LOCATION STALE' })[source] || 'WAITING FOR GPS ETA' };
}

export function trackSvg(card) {
  const valid = p => p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  const track = (card.track || []).filter(valid).slice(-120);
  if (valid(card.last_position) && (!track.length || track[track.length-1].at !== card.last_position.at)) track.push(card.last_position);
  if (!track.length) return '<div class="map-placeholder">Waiting for ambulance GPS…</div>';
  const hospital = valid(card.tracking_hospital) ? card.tracking_hospital : null;
  const all = hospital ? track.concat(hospital) : track;
  const midLat = Number(track[track.length-1].lat) * Math.PI / 180;
  const xs = all.map(p => Number(p.lng) * Math.cos(midLat)), ys = all.map(p => -Number(p.lat));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const scale = Math.max((Math.max(...xs)-Math.min(...xs))/260, (Math.max(...ys)-Math.min(...ys))/130, 0.000002);
  const xy = p => [150 + (Number(p.lng)*Math.cos(midLat)-cx)/scale, 85 + (-Number(p.lat)-cy)/scale];
  const points = track.map(p => xy(p).map(n=>n.toFixed(2)).join(',')).join(' ');
  const [x,y] = xy(track[track.length-1]);
  const h = hospital ? xy(hospital) : null;
  return `<svg class="gps-trail" viewBox="0 0 300 170" role="img" aria-label="Recent ambulance GPS trail; cyan ambulance and orange hospital. North is up. This is not a road map.">
    <path d="M0 42H300M0 85H300M0 128H300M75 0V170M150 0V170M225 0V170" class="trail-grid"/>
    <polyline points="${points}" class="trail-line"/>
    ${h ? `<rect x="${h[0]-7}" y="${h[1]-7}" width="14" height="14" rx="3" class="trail-hospital"/>` : ''}
    <circle cx="${x}" cy="${y}" r="7" class="trail-ambulance"/>
    <text x="280" y="16" class="trail-north">N ↑</text>
  </svg><div class="map-readout">● Ambulance · ■ Hospital · GPS trail, not a road map</div>`;
}
