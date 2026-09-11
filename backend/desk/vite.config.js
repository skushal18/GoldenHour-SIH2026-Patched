import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================================
   The ER desk board's build.

   Same shape as the ambulance app's (see app/vite.config.js for the reasoning
   behind the classic-script output), with one thing worth calling out: the
   output directory is backend/public/hospital, because that is what
   backend/src/server.js serves at /hospital. A previous revision pointed this
   at a public/hospital directory at the repository root, which nothing serves
   — so every desk build silently went nowhere and the board on screen was
   whatever stale file happened to be committed.
   ========================================================================== */

export default defineConfig({
  root: path.resolve(here, 'src'),
  base: './',
  publicDir: false,
  build: {
    outDir: path.resolve(here, '..', 'public', 'hospital'),
    /* config.js is hand-written and lives in the output directory. */
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: false,
    target: 'es2017',
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'dashboard.js',
        assetFileNames: 'dashboard.css',
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [classicScriptTags()],
});

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

      /* The bundle is a classic script and needs `io` and GH_DESK_CONFIG to
         already exist, so it goes last rather than in <head>. */
      const entry = /[ \t]*<script src="dashboard\.js"><\/script>\s*/;
      if (entry.test(out)) {
        out = out.replace(entry, '');
        out = out.replace(/<\/body>/, '<script src="dashboard.js"></script>\n</body>');
      }
      return out;
    },
  };
}
