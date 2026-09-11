/* Native plugin watch IDs are async; browser watch IDs are synchronous.
   Returning a cancel function immediately also handles arrival while the
   Android permission prompt / watch registration is still pending. */
export function watchPosition({ native, plugin, geolocation, onPosition, onError }) {
  let cancelled = false, id = null;
  const options = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000, minimumUpdateInterval: 10000, interval: 10000 };
  const clear = () => {
    if (id === null) return;
    if (native) Promise.resolve(plugin.clearWatch({ id })).catch(() => {});
    else geolocation.clearWatch(id);
    id = null;
  };
  const success = pos => { if (!cancelled) onPosition(pos); };
  const failure = err => { if (!cancelled) onError(err); };
  if (native) {
    Promise.resolve().then(async () => {
      const permission = await plugin.requestPermissions({ permissions: ['location'] });
      if (cancelled) return;
      if (permission.location !== 'granted') throw new Error('Allow precise location permission to share GPS.');
      id = await plugin.watchPosition(options, (pos, err) => err ? failure(err) : pos && success(pos));
      if (cancelled) clear();
    }).catch(failure);
  } else {
    try {
      if (!geolocation || !geolocation.watchPosition) throw new Error('Location service is unavailable.');
      id = geolocation.watchPosition(success, failure, options);
    } catch (err) { failure(err); }
  }
  return () => { cancelled = true; clear(); };
}
