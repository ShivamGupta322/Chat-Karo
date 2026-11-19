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
const restrict = (...patterns) => ['error', { patterns }];

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
      // Everywhere: strophe stays in src/xmpp/strophe, and only the geo index is importable.
      'no-restricted-imports': restrict(STROPHE, GEO_DEEP),
    },
  },
  {
    // The transport layer never imports geo at all.
    files: ['src/xmpp/**'],
    rules: { 'no-restricted-imports': restrict(STROPHE, GEO_ANY) },
  },
  {
    // geo may import its own modules directly; it must stay silent (no console at all) so nothing can log a position.
    files: ['src/geo/**'],
    rules: {
      'no-restricted-imports': restrict(STROPHE),
      // A bare severity would inherit the base allow list (warn, error), so pass explicit empty options.
      'no-console': ['error', {}],
    },
  },
  {
    // The strophe adapter may import strophe.js, but still not geo.
    files: ['src/xmpp/strophe/**'],
    rules: { 'no-restricted-imports': restrict(GEO_ANY) },
  },
  {
    // Tests may reach into geo/ internals; only the strophe wire tests may import strophe.js.
    files: ['tests/**'],
    rules: { 'no-restricted-imports': restrict(STROPHE) },
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
