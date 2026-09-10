#!/usr/bin/env node
/* ============================================================================
   WCAG 2.1 contrast verifier for tokens.css.
   Light + dark, text + border pairs. Exits non-zero if a floor is missed.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

function readTokens(file) {
  // Extract only the :root{...} and :root[data-theme="dark"]{...} blocks
  const txt = fs.readFileSync(file, 'utf8');
  const blocks = [];
  const re = /:root[^{]*\{([^}]*)\}/g;
  let m; while ((m = re.exec(txt)) !== null) blocks.push(m[1]);
  return blocks;
}

function parseVars(block) {
  // Each block is "  --name: #hex;\n  ...  --name2: #hex;". Resolve hex only.
  const map = {};
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi;
  let m; while ((m = re.exec(block)) !== null) map[m[1]] = m[2];
  return map;
}

function toRgb(value) {
  const v = value.replace(/\s/g, '').toLowerCase();
  // hex
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let s = hex[1];
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    if (s.length === 6) return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
    if (s.length === 8) return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)];
  }
  const rgb = v.match(/rgba?\((\d+),(\d+),(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return null;
}

function relLum([r, g, b]) {
  const ch = c => { c /= 255; return c <= .03928 ? c/12.92 : Math.pow((c+.055)/1.055, 2.4); };
  return .2126 * ch(r) + .7152 * ch(g) + .0722 * ch(b);
}

function ratio(a, b) {
  const la = relLum(toRgb(a)), lb = relLum(toRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + .05) / (lo + .05);
}

const tokensPath = path.join(__dirname, 'tokens.css');
const [light, dark] = readTokens(tokensPath);
const L = parseVars(light);
const D = parseVars(dark);

const TEXT_PAIRS = [
  ['ink','surface'],['ink','page'],['ink','surface-2'],
  ['ink-2','surface'],['ink-2','page'],['ink-2','surface-2'],
  ['muted','surface'],['muted','page'],['muted','surface-2'],
  ['brand-ink','surface'],['brand-ink','page'],['brand-ink','brand-wash'],
  ['accent-ink','surface'],['accent-ink','page'],['accent-ink','accent-wash'],
  ['good-ink','surface'],['good-ink','good-wash'],
  ['caution-ink','surface'],['caution-ink','caution-wash'],
  ['critical-ink','surface'],['critical-ink','critical-wash'],
  ['on-brand','brand-fill'],['on-accent','accent-fill'],
  ['on-critical','critical-fill'],['on-caution','caution-fill'],
];
const BORDER_PAIRS = [
  ['line-strong','surface'],['line-strong','surface-2'],['line-strong','page'],
  ['brand-line','surface'],['brand-line','brand-wash'],
  ['accent-line','surface'],['accent-line','accent-wash'],
  ['good-line','surface'],['good-line','good-wash'],
  ['caution-line','surface'],['caution-line','caution-wash'],
  ['critical-line','surface'],['critical-line','critical-wash'],
];

let failures = 0;
function checkPair(label, pair, theme, vars, floor) {
  const [fg, bg] = pair;
  if (!vars[fg] || !vars[bg]) return;
  const r = ratio(vars[fg], vars[bg]);
  if (r < floor) {
    failures++;
    console.error(`  ✗ ${theme} ${label} ${fg} on ${bg} = ${r.toFixed(2)}:1 (need ≥ ${floor}:1)`);
  }
}

console.log('WCAG contrast check — GoldenHour v5 design system');
for (const pair of TEXT_PAIRS) { checkPair('text', pair, 'light', L, 4.5); checkPair('text', pair, 'dark', D, 4.5); }
for (const pair of BORDER_PAIRS) { checkPair('border', pair, 'light', L, 3.0); checkPair('border', pair, 'dark', D, 3.0); }
const total = (TEXT_PAIRS.length + BORDER_PAIRS.length) * 2;
const ok = total - failures;
console.log(`→ ${total} pairs checked · ${ok} ok · ${failures} failed`);
process.exit(failures ? 1 : 0);
