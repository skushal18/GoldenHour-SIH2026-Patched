#!/usr/bin/env node
/* Packs dist/web into dist/web-bundle.json — one upload for environments that
   can PUT a single file but cannot run `aws s3 sync` (e.g. a cloud session
   reaching AWS through presigned URLs). Each entry: key, contentType,
   cacheControl and either text or hex (binary). */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', 'dist', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '': 'text/plain; charset=utf-8' };
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '']);
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    const key = path.relative(root, full).split(path.sep).join('/');
    const ext = path.extname(name).toLowerCase();
    const entry = { key, contentType: TYPES[ext] || 'application/octet-stream',
      cacheControl: key.startsWith('vendor/') ? 'public, max-age=86400' : 'no-cache' };
    if (TEXT.has(ext)) entry.text = fs.readFileSync(full, 'utf8'); else entry.hex = fs.readFileSync(full).toString('hex');
    files.push(entry);
  }
})(root);
fs.writeFileSync(path.join(root, '..', 'web-bundle.json'), JSON.stringify({ files }));
console.log('web-bundle.json: ' + files.length + ' files');
