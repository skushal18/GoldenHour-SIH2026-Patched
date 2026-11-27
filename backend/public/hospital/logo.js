/* ============================================================================
   GoldenHour mark — an ambulance in front of a golden sun whose face is a
   clock: the first hour after an injury, when care matters most.

   One drawing, used everywhere:
     <span data-logo></span>              the mark (header, cards)
     <div data-scene></div>               the animated sunset scene (sign-in)
   Every instance gets its own gradient ids, so a copy inside a hidden view
   never breaks a visible one.
   ========================================================================== */
(function () {
  'use strict';
  var n = 0;

  /* The mark, on a 64 × 64 grid. */
  function mark(opts) {
    var o = opts || {};
    var id = 'ghl' + (++n);
    var anim = o.animated ? ' gh-anim' : '';
    var ticks = '';
    for (var i = 0; i < 12; i++) {
      var long = i % 3 === 0;
      ticks += '<line x1="32" y1="' + (long ? 14.2 : 15.2) + '" x2="32" y2="17" transform="rotate(' + (i * 30) + ' 32 27)" stroke="#9A4A06" stroke-width="' + (long ? 1.6 : 0.9) + '" stroke-linecap="round" opacity=".75"/>';
    }
    var rays = '';
    for (var r = 0; r < 16; r++) {
      rays += '<line x1="32" y1="2.5" x2="32" y2="' + (r % 2 ? 6 : 7.5) + '" transform="rotate(' + (r * 22.5) + ' 32 27)" stroke="' + (r % 2 ? '#FFC93C' : '#F59E0B') + '" stroke-width="2.4" stroke-linecap="round"/>';
    }
    return '' +
      '<svg class="gh-logo' + anim + '" viewBox="0 0 64 64" role="img" aria-label="GoldenHour" focusable="false">' +
        '<defs>' +
          '<radialGradient id="' + id + 's" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#FFF1B8"/><stop offset=".45" stop-color="#FFC93C"/><stop offset="1" stop-color="#F08A24"/></radialGradient>' +
          '<linearGradient id="' + id + 'b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F4E9DC"/></linearGradient>' +
        '</defs>' +
        '<g class="gh-rays">' + rays + '</g>' +
        '<circle cx="32" cy="27" r="16.5" fill="url(#' + id + 's)" stroke="#E07A12" stroke-width="1.2"/>' +
        '<circle cx="32" cy="27" r="13.4" fill="none" stroke="#FFF6D6" stroke-width=".8" opacity=".7"/>' +
        ticks +
        /* hands: the hour hand at one o'clock — the golden hour — and a sweeping minute hand */
        '<line class="gh-hand-h" x1="32" y1="27" x2="32" y2="19.5" transform="rotate(30 32 27)" stroke="#5A2A06" stroke-width="2.4" stroke-linecap="round"/>' +
        '<line class="gh-hand-m" x1="32" y1="27" x2="32" y2="16" stroke="#7A3A08" stroke-width="1.5" stroke-linecap="round"/>' +
        '<circle cx="32" cy="27" r="1.7" fill="#5A2A06"/>' +
        /* the ambulance, in front of the sun */
        '<g class="gh-amb">' +
          '<path d="M7 38.5 h30 a2 2 0 0 1 2 2 v12.5 h-32 a2 2 0 0 1 -2 -2 v-10.5 a2 2 0 0 1 2 -2z" fill="url(#' + id + 'b)" stroke="#3B1838" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M39 43 h8.5 l6.5 6.2 v3.8 h-15z" fill="url(#' + id + 'b)" stroke="#3B1838" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M41.2 44.8 h5.6 l3.8 3.6 h-9.4z" fill="#7CC6D6" stroke="#3B1838" stroke-width=".9" stroke-linejoin="round"/>' +
          '<rect x="5" y="47.2" width="49" height="2" fill="#C2410C"/>' +
          '<path d="M19.6 41 h3.6 v3 h3 v3.6 h-3 v3 h-3.6 v-3 h-3 v-3.6 h3z" fill="#D7261E"/>' +
          '<rect class="gh-siren" x="13" y="36" width="5.5" height="2.6" rx="1.1" fill="#E5342B"/>' +
          '<circle cx="15" cy="53.6" r="4" fill="#2A1430"/><circle cx="15" cy="53.6" r="1.6" fill="#E9D8C3"/>' +
          '<circle cx="45" cy="53.6" r="4" fill="#2A1430"/><circle cx="45" cy="53.6" r="1.6" fill="#E9D8C3"/>' +
        '</g>' +
      '</svg>';
  }

  /* The sign-in scene: night sky turning to gold, stars, the sun-clock rising
     behind the horizon, and an ambulance crossing on the road. */
  function scene() {
    var stars = '';
    var pts = [[8, 12], [22, 6], [36, 16], [54, 8], [70, 14], [86, 5], [92, 20], [14, 26], [62, 24], [78, 30], [44, 4], [30, 30]];
    pts.forEach(function (p, i) { stars += '<i style="left:' + p[0] + '%;top:' + p[1] + '%;animation-delay:' + (i * 0.37).toFixed(2) + 's"></i>'; });
    return '' +
      '<div class="gh-scene" aria-hidden="true">' +
        '<div class="gh-stars">' + stars + '</div>' +
        '<div class="gh-sun">' + mark({ animated: true }).replace('<g class="gh-amb">', '<g class="gh-amb" style="display:none">') + '</div>' +
        '<svg class="gh-ground" viewBox="0 0 400 90" preserveAspectRatio="none">' +
          '<path d="M0 40 L24 40 L24 22 L40 22 L40 34 L52 34 L52 14 L70 14 L70 30 L84 30 L84 40 L120 40 L120 26 L134 26 L134 18 L150 18 L150 40 L250 40 L250 24 L262 24 L262 10 L280 10 L280 30 L296 30 L296 40 L330 40 L330 20 L346 20 L346 32 L360 32 L360 40 L400 40 L400 90 L0 90 Z" fill="#2A1430" opacity=".55"/>' +
          '<rect y="44" width="400" height="46" fill="#1B1023"/>' +
          '<path d="M0 66 H400" stroke="#F6C453" stroke-width="2" stroke-dasharray="16 14" opacity=".55"/>' +
        '</svg>' +
        '<div class="gh-drive">' + mark().replace('<g class="gh-rays">', '<g class="gh-rays" style="display:none">').replace(/<circle cx="32" cy="27" r="16.5"[\s\S]*?<circle cx="32" cy="27" r="1.7" fill="#5A2A06"\/>/, '') + '</div>' +
      '</div>';
  }

  function paint(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-logo]'), function (el) {
      if (!el.firstChild) el.innerHTML = mark({ animated: el.hasAttribute('data-animated') });
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-scene]'), function (el) {
      if (!el.firstChild) el.innerHTML = scene();
    });
  }

  window.GHLogo = { mark: mark, scene: scene, paint: paint };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { paint(); });
  else paint();
})();
