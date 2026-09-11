/* ============================================================
   GoldenHour — server resolution tests

   Four contexts the app can find itself in, and the one rule that
   matters in each: does it know where its backend is?

   The APK case is the subtle one. Capacitor serves the app's own
   assets from https://localhost, so "use the page origin" would
   silently resolve to https://localhost/api/v1 — a server that does
   not exist — instead of falling back to demo mode. The crew would
   see a form that never sends. This suite is what stops that
   regression coming back.

   Run:  node tests/config.test.js
   ============================================================ */

var fs = require("fs");
var path = require("path");
var assert = require("assert");
var jsdomLib = require("jsdom");
var JSDOM = jsdomLib.JSDOM;
var VirtualConsole = jsdomLib.VirtualConsole;

var ROOT = path.join(__dirname, "..", "www");
var html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
var configSource = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
var appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

var passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}
function group(title) { console.log("\n" + title); }

/** Boot the real app in a simulated environment and read back what it decided. */
function boot(options) {
  var opts = options || {};
  var vc = new VirtualConsole();
  vc.on("jsdomError", function () {});

  var dom = new JSDOM(html, {
    url: opts.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  var w = dom.window;

  w.eval(configSource);
  if (opts.serverBase !== undefined) w.GH_CONFIG.SERVER_BASE = opts.serverBase;
  if (opts.mode !== undefined) w.GH_CONFIG.MODE = opts.mode;

  /* The Capacitor bridge is injected into the WebView before app.js runs. */
  if (opts.capacitor) {
    w.Capacitor = { isNativePlatform: function () { return true; }, Plugins: {} };
  }

  w.eval(appSource);
  var state = w.__GH.state();
  w.__GH.stopPolling();
  var result = { demo: state.demo, window: w };
  w.close();
  return result;
}

group("Shipped config defaults");
check("config.js ships with an empty SERVER_BASE so a browser build auto-detects", function () {
  var dom = new JSDOM("", { runScripts: "outside-only" });
  dom.window.eval(configSource);
  assert.strictEqual(dom.window.GH_CONFIG.SERVER_BASE, "");
  assert.strictEqual(dom.window.GH_CONFIG.API_PATH, "/api/v1");
  assert.strictEqual(dom.window.GH_CONFIG.MODE, "auto");
  dom.window.close();
});

group("Where the app thinks its backend is");

check("APK with no SERVER_BASE falls back to demo, NOT https://localhost", function () {
  var r = boot({ url: "https://localhost/", capacitor: true });
  assert.strictEqual(r.demo, true,
    "the APK guessed its own WebView origin as the backend — the form would never send");
});

check("APK with SERVER_BASE set goes live", function () {
  var r = boot({ url: "https://localhost/", capacitor: true, serverBase: "http://192.168.1.100:5000" });
  assert.strictEqual(r.demo, false);
});

check("a browser served by the backend auto-detects it", function () {
  var r = boot({ url: "http://192.168.1.100:5000/ambulance/" });
  assert.strictEqual(r.demo, false);
});

check("index.html opened straight off disk runs in demo mode", function () {
  var r = boot({ url: "file:///tmp/index.html" });
  assert.strictEqual(r.demo, true);
});

check("MODE 'demo' wins even when a server is reachable", function () {
  var r = boot({ url: "http://192.168.1.100:5000/ambulance/", mode: "demo" });
  assert.strictEqual(r.demo, true);
});

check("MODE 'live' wins even with nothing configured", function () {
  var r = boot({ url: "file:///tmp/index.html", mode: "live" });
  assert.strictEqual(r.demo, false);
});

check("a leftover REPLACE-WITH-YOUR-BACKEND placeholder is treated as unset", function () {
  var r = boot({ url: "https://localhost/", capacitor: true, serverBase: "https://REPLACE-WITH-YOUR-BACKEND" });
  assert.strictEqual(r.demo, true);
});

group("APK plumbing");
check("index.html loads config.js before app.js", function () {
  var config = html.indexOf('src="config.js"');
  var app = html.indexOf('src="app.js"');
  assert.ok(config !== -1, "config.js is not loaded at all");
  assert.ok(app !== -1, "app.js is not loaded at all");
  assert.ok(config < app, "config.js must load first or GH_CONFIG is undefined");
});
check("the Socket.IO client is vendored, not fetched from a CDN", function () {
  assert.ok(fs.existsSync(path.join(ROOT, "vendor", "socket.io.min.js")),
    "www/vendor/socket.io.min.js is missing — the APK would have no realtime offline");
  assert.strictEqual(/<script[^>]+src="https?:/.test(html), false,
    "a script is loaded over the network; the APK must be self-contained");
});
check("capacitor.config.json points at www and allows the LAN's plain HTTP", function () {
  var cap = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "capacitor.config.json"), "utf8"));
  assert.strictEqual(cap.webDir, "www");
  assert.strictEqual(cap.android.allowMixedContent, true);
});
check("the Android manifest permits cleartext traffic and internet access", function () {
  var manifest = fs.readFileSync(
    path.join(__dirname, "..", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
  assert.ok(manifest.indexOf('android:usesCleartextTraffic="true"') !== -1,
    "without this the APK cannot reach http://<laptop>:5000 on Android 9+");
  assert.ok(manifest.indexOf("android.permission.INTERNET") !== -1);
  assert.ok(manifest.indexOf("ACCESS_FINE_LOCATION") !== -1);
});

console.log("\n" + (failed === 0 ? "PASS" : "FAIL") + " — " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
