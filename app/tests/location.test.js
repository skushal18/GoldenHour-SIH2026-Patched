/* ============================================================
   GoldenHour — location fallback tests

   The scenario these exist for:

     A phone browser opens the app from a laptop's LAN address,
     http://192.168.1.100:5000/ambulance. Chrome refuses geolocation
     because a private-IP http origin is not a secure context. Without
     a way through, the crew stares at a form that will not send.

   So: GPS first, then the last fix from this shift, then a one-tap
   preset, then typed coordinates — and the payload always records
   which of those it was, because the ER reads a distance differently
   when the position was typed rather than measured.

   Run:  node tests/location.test.js
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
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * Boot the real app with geolocation behaving however the test needs.
 * `geo` is null (no API at all — what jsdom and a locked-down WebView give
 * you) or a fake that fails with a specific GeolocationPositionError.
 */
function boot(options) {
  var opts = options || {};
  var vc = new VirtualConsole();
  vc.on("jsdomError", function () {});

  var dom = new JSDOM(html, {
    url: opts.url || "http://192.168.1.100:5000/ambulance/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  var w = dom.window;

  w.eval(configSource);
  w.__GH_POLL_MS = 5;
  w.__GH_DEMO = false;                 /* the live path — demo mode always has a position */

  if (opts.geo) {
    w.navigator.geolocation = opts.geo;
  }
  if (opts.lastFix) {
    try { w.localStorage.setItem("gh_last_fix", JSON.stringify(opts.lastFix)); } catch (e) {}
  }

  w.eval(appSource);
  return w;
}

function $(w, id) { return w.document.getElementById(id); }

function failingGeo(code, message) {
  return {
    getCurrentPosition: function (ok, fail) {
      setTimeout(function () { fail({ code: code, message: message }); }, 0);
    }
  };
}

async function main() {

  /* ── 1. The panel only appears when it is needed ──────────── */
  group("The fallback panel stays out of the way");

  var w = boot({ geo: failingGeo(1, "User denied Geolocation") });
  await sleep(60);

  check("a refused GPS reveals the starting-point panel", function () {
    assert.strictEqual($(w, "locFallback").hidden, false);
  });
  check("the message says what to do, not just what broke", function () {
    var text = $(w, "locationStatus").textContent;
    assert.ok(/permission was refused/i.test(text), "unhelpful message: " + text);
    assert.ok(/starting point/i.test(text), "no next step offered: " + text);
  });
  check("the preset shortcut from config.js is offered", function () {
    var chips = $(w, "locFallbackChips").querySelectorAll(".chip");
    assert.ok(chips.length >= 1, "no shortcut chips rendered");
    assert.ok(/Bengaluru/i.test($(w, "locFallbackChips").textContent));
  });
  check("without a location the broadcast is still blocked", function () {
    assert.strictEqual(w.__GH.hasUsableLocation(), false);
    assert.ok($(w, "submitHint").className.indexOf("is-bad") !== -1);
  });

  /* ── 2. One tap unblocks it ───────────────────────────────── */
  group("One tap on the preset");

  /* Pick a case first, so the hint is talking about the location and not
     about the empty dropdown. */
  var caseSel = $(w, "caseType");
  caseSel.value = "12";
  caseSel.dispatchEvent(new w.Event("change", { bubbles: true }));

  $(w, "locFallbackChips").querySelectorAll(".chip")[0].click();

  check("the app now has a usable position", function () {
    assert.strictEqual(w.__GH.hasUsableLocation(), true);
  });
  check("the hint says the broadcast is ready AND that it was set by hand", function () {
    var hint = $(w, "submitHint").textContent;
    assert.ok(hint.indexOf("Ready") !== -1, hint);
    assert.ok(/by hand/i.test(hint), "the crew is not told the position is not measured: " + hint);
  });
  check("the location box no longer reads as an error", function () {
    assert.ok($(w, "locBox").className.indexOf("loc-error") === -1);
    assert.ok($(w, "locBox").className.indexOf("loc-manual") !== -1);
  });

  var state = w.__GH.state();
  check("the position is tagged 'manual', never passed off as GPS", function () {
    assert.strictEqual(state.location.source, "manual");
    assert.strictEqual(state.location.accuracy, null);
  });

  /* ── 3. Typed coordinates ─────────────────────────────────── */
  group("Typed coordinates");

  var w2 = boot({ geo: failingGeo(2, "Position unavailable") });
  await sleep(60);

  $(w2, "manualLat").value = "13.0827";
  $(w2, "manualLng").value = "80.2707";
  $(w2, "useManualBtn").click();

  check("typing a lat/lng sets the origin", function () {
    var s = w2.__GH.state().location;
    assert.strictEqual(s.lat, 13.0827);
    assert.strictEqual(s.lng, 80.2707);
    assert.strictEqual(s.source, "manual");
  });

  check("nonsense coordinates are refused, not silently accepted", function () {
    $(w2, "manualLat").value = "999";
    $(w2, "manualLng").value = "80.2707";
    var accepted = w2.__GH.useTypedCoordinates();
    assert.strictEqual(accepted, false);
    assert.strictEqual(w2.__GH.state().location.lat, 13.0827, "the bad value overwrote a good one");
  });

  check("a half-filled pair is refused", function () {
    $(w2, "manualLat").value = "13.0";
    $(w2, "manualLng").value = "";
    assert.strictEqual(w2.__GH.useTypedCoordinates(), false);
  });

  /* ── 4. The payload tells the truth ───────────────────────── */
  group("What reaches the backend");

  var sel = $(w2, "caseType");
  sel.value = "12";
  sel.dispatchEvent(new w2.Event("change", { bubbles: true }));
  await w2.__GH.submitLoop();
  var payload = w2.__GH_LAST_PAYLOAD;

  check("the broadcast went out with the hand-set origin", function () {
    assert.ok(payload, "nothing was sent");
    assert.strictEqual(payload.origin.lat, 13.0827);
    assert.strictEqual(payload.origin.lng, 80.2707);
  });
  check("origin.source travels with it so the ER can weigh the distance", function () {
    assert.strictEqual(payload.origin.source, "manual");
  });
  check("a hand-set origin carries no invented accuracy", function () {
    assert.strictEqual(payload.origin.accuracy_m, null);
  });

  /* ── 5. Last known fix ────────────────────────────────────── */
  group("Last known fix");

  var w3 = boot({
    geo: failingGeo(3, "Timeout expired"),
    lastFix: { lat: 12.34, lng: 77.65, accuracy: 12, ts: Date.now() - 4 * 60 * 1000 }
  });
  await sleep(60);

  check("a recent fix is offered as a shortcut", function () {
    var text = $(w3, "locFallbackChips").textContent;
    assert.ok(/Last fix/i.test(text), "no last-fix chip: " + text);
    assert.ok(/4 min ago/.test(text), "the age is not shown: " + text);
  });
  check("taking it restores the coordinates, tagged as recalled", function () {
    $(w3, "locFallbackChips").querySelectorAll(".chip")[0].click();
    var s = w3.__GH.state().location;
    assert.strictEqual(s.lat, 12.34);
    assert.strictEqual(s.source, "last-known");
  });

  var w4 = boot({
    geo: failingGeo(3, "Timeout expired"),
    lastFix: { lat: 12.34, lng: 77.65, accuracy: 12, ts: Date.now() - 30 * 60 * 60 * 1000 }
  });
  await sleep(60);
  check("a stale fix from yesterday is NOT offered", function () {
    assert.strictEqual(/Last fix/i.test($(w4, "locFallbackChips").textContent), false,
      "a day-old position would put the ambulance in the wrong city");
  });

  /* ── 6. The secure-origin trap, in words ──────────────────── */
  group("The secure-origin trap");

  var w5 = boot({ geo: failingGeo(1, "Only secure origins are allowed") });
  await sleep(60);
  check("Chrome's secure-origin refusal is explained in plain language", function () {
    var text = $(w5, "locationStatus").textContent;
    assert.ok(/plain http/i.test(text), "the real cause is not named: " + text);
    assert.ok(/app build|starting point/i.test(text), "no way out is offered: " + text);
  });

  /* ── 7. GPS, when it works, still wins ────────────────────── */
  group("When GPS works");

  var w6 = boot({
    geo: {
      getCurrentPosition: function (ok) {
        setTimeout(function () { ok({ coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 9 } }); }, 0);
      }
    }
  });
  await sleep(60);

  check("a good fix hides the fallback panel entirely", function () {
    assert.strictEqual($(w6, "locFallback").hidden, true);
  });
  check("the origin is tagged 'gps' with its real accuracy", function () {
    var s = w6.__GH.state().location;
    assert.strictEqual(s.source, "gps");
    assert.strictEqual(s.accuracy, 9);
    assert.strictEqual(s.status, "ready");
  });
  check("the fix is remembered for the next case", function () {
    var raw = w6.localStorage.getItem("gh_last_fix");
    assert.ok(raw, "nothing was stored");
    assert.strictEqual(JSON.parse(raw).lat, 12.9716);
  });

  [w, w2, w3, w4, w5, w6].forEach(function (win) {
    try { win.__GH.stopPolling(); win.close(); } catch (e) {}
  });

  console.log("\n" + (failed === 0 ? "PASS" : "FAIL") + " — " + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.log("\nHARNESS ERROR: " + (err && err.stack || err));
  process.exit(1);
});
