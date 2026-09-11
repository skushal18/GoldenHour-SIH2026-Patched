/* ============================================================================
   GoldenHour — ambulance app configuration

   ★ THE ONE LINE TO EDIT WHEN YOU BUILD THE APK ★

   Opened in a browser from the server (http://<server-ip>:5000/ambulance) the
   app finds the backend by itself — leave SERVER_BASE empty.

   Inside the Android APK there is no server to infer, so put the server
   laptop's LAN address here before you run `npm run apk`:

       SERVER_BASE: "https://goldenhour-sih2026-patched-production.up.railway.app"

   Find that address by starting the backend — it prints it in the banner.

   You can also leave this file alone and pass the address to the GitHub
   Actions "Build GoldenHour APK" workflow instead: it rewrites the line below
   before building. Same result, one less thing to forget.
   ========================================================================== */

window.GH_CONFIG = {
  /* "" = auto-detect from the page URL. Set explicitly for the APK. */
  SERVER_BASE: "https://goldenhour-sih2026-patched-production.up.railway.app",

  API_PATH: "/api/v1",

  /* "auto" — live when a server can be resolved, demo when it cannot
     "live" — always talk to the server
     "demo" — never touch the network (sample data, simulated acceptance) */
  MODE: "auto",

  /* Socket.IO push. The app still polls as a safety net either way. */
  REALTIME: true,

  /* Status poll interval in ms. Realtime makes this a backstop, not the
     main channel, so it can be relaxed. */
  POLL_MS: 4000,

  /* One-tap starting point offered when the device gives no GPS fix.
     A phone browser on a plain-http LAN address is refused geolocation by
     Chrome (only secure origins get it), and an ambulance app that cannot
     send because of that is useless — so the crew is always given a way
     through. Set to null to remove the shortcut and force manual entry.

     These coordinates are central Bengaluru, which is where the seeded
     hospitals are. Change them to wherever you are demoing. */
  FALLBACK_ORIGIN: { lat: 12.9716, lng: 77.5946, label: "Bengaluru city centre" }
};
