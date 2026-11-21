import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Flat config replaces a rule wholesale per files-block, so every block re-lists its patterns.
const STROPHE = {
  group: ['strophe.js', 'strophe.js/*'],
  message: 'Only src/xmpp/strophe/** may import strophe.js.',
};
const GEO_DEEP = {
  group: ['**/geo/*'],
  message: "Import geo only through its index ('../geo'): raw coordinates must not leak out of src/geo/.",
};
const GEO_ANY = {
  group: ['**/geo', '**/geo/*'],
  message: 'src/xmpp/ must not depend on geo/: the transport layer never sees a location.',
};
const LEAFLET = {
  group: ['leaflet', 'leaflet/*', 'react-leaflet', 'react-leaflet/*', '@react-leaflet/*'],
  message:
    'Only src/geo/DevMap.tsx may import Leaflet: it is lazy-loaded in dev only and must never reach a production bundle.',
};
const API_ANY = {
  group: ['**/api', '**/api/*'],
  message: 'src/xmpp/ must not depend on api/.',
};
const API_LEAF = {
  group: ['../*', '../**'],
  message: 'src/api/ is a leaf: it imports nothing from the rest of the app.',
};
const restrict = (...patterns) => ['error', { patterns }];

// Network and storage are confined to src/api/ (ADR-019 D4). Flat config replaces a rule wholesale per
// block, so each block below re-lists everything it still needs from these constants.
const NET_MESSAGE = 'Only src/api/ may make network requests.';
const STORAGE_MESSAGE = 'Only src/api/deviceCredential.ts may use browser storage.';
const NET_GLOBALS = ['fetch', 'XMLHttpRequest'];
const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB'];
const globalsRule = (names, message) => names.map((name) => ({ name, message }));
const propertiesRule = (names, message) =>
  ['window', 'globalThis', 'self'].flatMap((object) =>
    names.map((property) => ({ object, property, message })),
  );
const NET_PROPERTIES = [
  ...propertiesRule(NET_GLOBALS, NET_MESSAGE),
  { object: 'navigator', property: 'sendBeacon', message: NET_MESSAGE },
];
const STORAGE_PROPERTIES = propertiesRule(STORAGE_GLOBALS, STORAGE_MESSAGE);
const restrictList = (...lists) => ['error', ...lists.flat()];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-globals': restrictList(
        globalsRule(NET_GLOBALS, NET_MESSAGE),
        globalsRule(STORAGE_GLOBALS, STORAGE_MESSAGE),
      ),
      'no-restricted-properties': restrictList(NET_PROPERTIES, STORAGE_PROPERTIES),
      // Everywhere: strophe stays in src/xmpp/strophe, and only the geo index is importable.
      'no-restricted-imports': restrict(STROPHE, GEO_DEEP, LEAFLET),
    },
  },
  {
    // The transport layer never imports geo at all.
    files: ['src/xmpp/**'],
    rules: { 'no-restricted-imports': restrict(STROPHE, GEO_ANY, API_ANY, LEAFLET) },
  },
  {
    // geo may import its own modules directly; it must stay silent (no console at all) so nothing can log a position.
    files: ['src/geo/**'],
    rules: {
      'no-restricted-imports': restrict(STROPHE, LEAFLET),
      // A bare severity would inherit the base allow list (warn, error), so pass explicit empty options.
      'no-console': ['error', {}],
    },
  },
  {
    // src/api/ is a leaf that may fetch but never store, and stays silent (no console: it handles secrets).
    files: ['src/api/**'],
    rules: {
      'no-restricted-imports': restrict(STROPHE, LEAFLET, API_LEAF),
      'no-restricted-globals': restrictList(globalsRule(STORAGE_GLOBALS, STORAGE_MESSAGE)),
      'no-restricted-properties': restrictList(STORAGE_PROPERTIES),
      'no-console': ['error', {}],
    },
  },
  {
    // The only file that may use browser storage (still no network).
    files: ['src/api/deviceCredential.ts'],
    rules: {
      'no-restricted-globals': restrictList(
        globalsRule(NET_GLOBALS, NET_MESSAGE),
        globalsRule(['sessionStorage', 'indexedDB'], STORAGE_MESSAGE),
      ),
      'no-restricted-properties': restrictList(
        NET_PROPERTIES,
        propertiesRule(['sessionStorage', 'indexedDB'], STORAGE_MESSAGE),
      ),
    },
  },
  {
    // The identity code handles the device credential: no console at all.
    files: ['src/state/identity*.{ts,tsx}', 'src/pages/Welcome.tsx'],
    rules: { 'no-console': ['error', {}] },
  },
  {
    // The one file allowed to import Leaflet (no-console stays inherited from the geo block).
    files: ['src/geo/DevMap.tsx'],
    rules: { 'no-restricted-imports': restrict(STROPHE) },
  },
  {
    // The strophe adapter may import strophe.js, but still not geo.
    files: ['src/xmpp/strophe/**'],
    rules: { 'no-restricted-imports': restrict(GEO_ANY, API_ANY, LEAFLET) },
  },
  {
    // Tests may reach into geo/ internals; only the strophe wire tests may import strophe.js.
    files: ['tests/**'],
    rules: {
      'no-restricted-imports': restrict(STROPHE),
      // Fakes need fetch and storage.
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['tests/xmpp/strophe/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['*.js', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
