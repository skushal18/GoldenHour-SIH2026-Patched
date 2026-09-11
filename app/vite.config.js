import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================================
   The ambulance app's build.

   Three decisions worth defending in review:

   1. A classic IIFE, not ESM. The bundle has two jobs — be a plain <script>
      inside an Android WebView, and be `require()`-able by app/tests/test.js
      so the pure logic can be unit-tested with no DOM. An IIFE does both:
      main.js publishes its API to `module.exports` when a CommonJS host is
      present and to `window.GH` otherwise. An ESM bundle would need
      type="module", which the WebView loads from https://localhost under
      different rules than a plain script, and would throw on its first
      import under `node tests/test.js`.

   2. socket.io and config.js stay outside the bundle. config.js is
      hand-edited (and rewritten by the APK workflow) and must not be
      generated; the vendored socket.io is what makes the APK work with no
      internet, and the server hands the same file to both front-ends at
      /vendor. Both keep their own plain <script> tags.

   3. minify: false. The stylesheet is read by the functional tests, and the
      project's debugging story is "open the shipped file and look". Gzip does
      the real work over the wire.
   ========================================================================== */

export default defineConfig({
  root: path.resolve(here, 'src'),
  base: './',
  publicDir: false,
  build: {
    outDir: path.resolve(here, 'www'),
    /* vendor/ and config.js live in www/ and are not generated. */
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: false,
    target: 'es2017',
    rollupOptions: {
      /* Without this, Vite builds the entry as an application and drops its
         exports, so `require('../www/app.js')` in the unit tests gets an
         empty object and every pure-logic assertion fails. */
      preserveEntrySignatures: 'strict',
      output: {
        format: 'iife',
        entryFileNames: 'app.js',
        assetFileNames: 'style.css',
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [classicScriptTags()],
});

/* Vite writes `<script type="module" crossorigin src="./app.js">`. The bundle
   is UMD, so both attributes are wrong: `crossorigin` changes how the WebView
   fetches a same-origin file, and `type="module"` would defer it past
   config.js in a way the app does not expect. The relative `./` is stripped
   too, so the emitted tags match what the APK plumbing tests look for. */
function classicScriptTags() {
  return {
    name: 'goldenhour-classic-tags',
    enforce: 'post',
    transformIndexHtml(html) {
      let out = html
        .replace(/\stype="module"/g, '')
        .replace(/\scrossorigin/g, '')
        .replace(/(<script[^>]*\ssrc=")\.\//g, '$1')
        .replace(/(<link[^>]*\shref=")\.\//g, '$1');

      /* Vite hoists the entry into <head> because a module script is deferred
         and its position does not matter. Ours is a classic script, and its
         position matters a great deal: config.js defines GH_CONFIG and the
         vendored socket.io defines `io`, and both must exist before app.js
         runs. So put it back at the end of <body>, after them. */
      const entry = /[ \t]*<script src="app\.js"><\/script>\s*/;
      if (entry.test(out)) {
        out = out.replace(entry, '');
        out = out.replace(/<\/body>/, '<script src="app.js"></script>\n</body>');
      }
      return out;
    },
  };
}
