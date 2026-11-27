/* Hand-written ER desk settings. Edit freely; nothing builds this file. */
window.GH_DESK_CONFIG = {
  ENABLE_SOUND: true,
  PRINT_ON_ARRIVE: false,
  /* How long an arrived case stays on the board as confirmation (ms). */
  ARRIVED_DWELL_MS: 25000,
  /* Street map for en-route ambulances. OpenStreetMap's public tiles suit a
     demo; for real use, point this at a tile provider you have an agreement
     with (and add its host to MAP_TILE_HOSTS on the server so the content
     security policy allows it). Set to "" to show the offline GPS trail only. */
  MAP_TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  MAP_ATTRIBUTION: "© OpenStreetMap contributors",
  /* The pages themselves send no Referer (Referrer-Policy: no-referrer), and
     OpenStreetMap's tile servers answer a tile request without one with an
     "Access blocked" tile. Map tiles alone send this site's origin — never a
     path — so the tile server can see which site is asking. */
  MAP_TILE_REFERRER_POLICY: "strict-origin-when-cross-origin",

  /* Live map statement. An ambulance this close is announced as arriving
     (banner + chime, once per case). */
  ARRIVING_MINUTES: 3,
  ARRIVING_KM: 1,
  /* This desk's own location is the hospital end of every map and ETA. A fix
     rougher than this (metres), or further than DESK_MAX_DRIFT_KM from the
     hospital's directory address, is not used — the address is used instead,
     and the board says why. The server applies the same limits. */
  DESK_MAX_ACCURACY_M: 1000
};
