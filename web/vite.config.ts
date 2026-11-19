import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// strophe.js ships Node-only fallbacks (require('ws') / require('jsdom')) in dist/strophe.esm.js
// and src/shims.js (the file Vite resolves in the browser), behind typeof WebSocket/DOMParser/
// document checks that never run in a browser. Neutralise them so no stray require() calls
// (or jsdom/ws module code) end up in the browser bundle. The file match and regex are tied to
// strophe.js 3.1.1 (pinned exactly); the warning below fires if an upgrade changes the layout.
const stropheNodeShims = (): Plugin => ({
  name: 'strophe-node-shims',
  enforce: 'pre',
  transform(code, id) {
    if (!/strophe\.js[\\/](?:dist[\\/]strophe\.esm|src[\\/]shims)\.js/.test(id)) return null;
    let count = 0;
    const out = code.replace(/require\((['"])(?:ws|jsdom)\1\)/g, () => {
      count += 1;
      return '(() => { throw new Error("node-only module"); })()';
    });
    if (count === 0) {
      this.warn('strophe-node-shims: matched a strophe.js file but replaced nothing; check regex');
    }
    return out;
  },
});

// envDir '..' lets the repo-root .env / .env.example drive the client. Vite only exposes
// VITE_* variables, so the other secrets in the root .env never reach the bundle.
// Do NOT change envPrefix and do NOT call loadEnv(mode, dir, '') here.
export default defineConfig({
  plugins: [stropheNodeShims(), react(), tailwindcss()],
  envDir: '..',
  server: { port: 5173, strictPort: true },
  // Pre-bundle at server start so opening the map doesn't trigger a re-optimise reload, which would lose the dev spot.
  optimizeDeps: { include: ['leaflet', 'react-leaflet'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
