// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// The architecture rules (ADR-019 D4) are ESLint rules, so they are tested by linting fixtures.
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
// Virtual files are not in the TS project: switch type-aware parsing off and assert on the guard rules only.
const eslint = new ESLint({ cwd: webRoot, overrideConfig: tseslint.configs.disableTypeChecked });

const GUARDS = [
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-imports',
  'no-console',
];

async function rulesFor(rel: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(webRoot, rel) });
  const ids = (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
  expect(ids).not.toContain('parse-error');
  return ids.filter((id) => GUARDS.includes(id));
}

describe('architecture boundaries', { timeout: 60_000 }, () => {
  describe('are enforced', () => {
    it.each<[string, string, string]>([
      ['fetch in a component', 'src/components/F.tsx', "fetch('/x');"],
      ['window.fetch in state', 'src/state/f.ts', "window.fetch('/x');"],
      ['globalThis.fetch in state', 'src/state/f.ts', "globalThis.fetch('/x');"],
      ['self.fetch in state', 'src/state/f.ts', "self.fetch('/x');"],
      ['XMLHttpRequest in a page', 'src/pages/F.tsx', 'new XMLHttpRequest();'],
      ['sendBeacon in geo', 'src/geo/f.ts', "navigator.sendBeacon('/x');"],
    ])('%s -> no-restricted-*', async (_name, rel, code) => {
      const ids = await rulesFor(rel, code);
      expect(ids.some((id) => id.startsWith('no-restricted-'))).toBe(true);
    });

    it('fetch in a component is a no-restricted-globals error', async () => {
      expect(await rulesFor('src/components/F.tsx', "fetch('/x');")).toContain('no-restricted-globals');
    });

    it('window.fetch, globalThis.fetch and self.fetch are no-restricted-properties errors', async () => {
      for (const obj of ['window', 'globalThis', 'self']) {
        expect(await rulesFor('src/state/f.ts', `${obj}.fetch('/x');`)).toContain(
          'no-restricted-properties',
        );
      }
    });

    it.each<[string, string, string]>([
      ['a component', 'src/components/F.tsx', "localStorage.getItem('k');"],
      ['http.ts', 'src/api/http.ts', "localStorage.getItem('k');"],
      ['sessionStorage in deviceCredential', 'src/api/deviceCredential.ts', "sessionStorage.getItem('k');"],
      ['indexedDB in deviceCredential', 'src/api/deviceCredential.ts', "indexedDB.open('k');"],
      ['fetch in deviceCredential', 'src/api/deviceCredential.ts', "fetch('/x');"],
    ])('storage or network misuse in %s -> no-restricted-globals', async (_name, rel, code) => {
      expect(await rulesFor(rel, code)).toContain('no-restricted-globals');
    });

    it('window.localStorage in App.tsx is a no-restricted-properties error', async () => {
      expect(await rulesFor('src/App.tsx', "window.localStorage.getItem('k');")).toContain(
        'no-restricted-properties',
      );
    });

    it.each<[string, string]>([
      ['src/xmpp/client.ts', "import { createHttp } from '../api';"],
      ['src/xmpp/strophe/s.ts', "import { createHttp } from '../../api';"],
      ['src/xmpp/client.ts', "import { createHttp } from '../api/http';"],
      ['src/api/session.ts', "import x from '../state/session'; void x;"],
      ['src/api/session.ts', "import x from '../xmpp'; void x;"],
    ])('%s: %s -> no-restricted-imports', async (rel, code) => {
      expect(await rulesFor(rel, code)).toContain('no-restricted-imports');
    });

    it.each<[string]>([['src/api/http.ts'], ['src/state/identityController.ts'], ['src/pages/Welcome.tsx']])(
      'console.warn in %s -> no-console',
      async (rel) => {
        expect(await rulesFor(rel, "console.warn('x');")).toContain('no-console');
      },
    );
  });

  describe('do not fire for the allowed places', () => {
    it('allows fetch in src/api/http.ts', async () => {
      const ids = await rulesFor('src/api/http.ts', "fetch('/x'); globalThis.fetch('/x');");
      expect(ids).toEqual([]);
    });

    it('allows localStorage in src/api/deviceCredential.ts', async () => {
      const ids = await rulesFor(
        'src/api/deviceCredential.ts',
        "localStorage.getItem('k'); window.localStorage.getItem('k');",
      );
      expect(ids).toEqual([]);
    });

    it('allows a sibling import inside src/api', async () => {
      const ids = await rulesFor('src/api/index.ts', "export { createHttp } from './http';");
      expect(ids).toEqual([]);
    });

    it('allows fetch and localStorage in tests', async () => {
      const ids = await rulesFor('tests/x.test.ts', "fetch('/x'); localStorage.clear();");
      expect(ids).toEqual([]);
    });

    it('still allows console.warn where the base rule does (components)', async () => {
      expect(await rulesFor('src/components/F.tsx', "console.warn('x');")).toEqual([]);
    });
  });
});
