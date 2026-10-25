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
  MAP_ATTRIBUTION: "© OpenStreetMap contributors"
};
