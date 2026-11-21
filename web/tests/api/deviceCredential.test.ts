import { describe, expect, it } from 'vitest';
import { CREDENTIAL_KEY, createCredentialStore } from '../../src/api/deviceCredential';

const DOMAIN = 'chaterl.localhost';
const JID = `u${'0123456789abcdef'.repeat(2)}@${DOMAIN}`;
const PASSWORD = `xp1_${'A1_-'.repeat(8)}`;
const CRED = { jid: JID, xmppPassword: PASSWORD, nickname: 'Alice_1' };
const STORED = { v: 1, jid: JID, xmppPassword: PASSWORD, nickname: 'Alice_1' };

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

describe('createCredentialStore', () => {
  it('saves the exact JSON under the exact key', () => {
    const s = memoryStorage();
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    expect(store.save(CRED)).toEqual({ ok: true });
    expect(CREDENTIAL_KEY).toBe('nearby.identity.v1');
    expect(s.getItem('nearby.identity.v1')).toBe(
      `{"v":1,"jid":"${JID}","xmppPassword":"${PASSWORD}","nickname":"Alice_1"}`,
    );
  });

  it('round-trips through load', () => {
    const s = memoryStorage();
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    store.save(CRED);
    expect(store.load()).toEqual(CRED);
  });

  it('writes only the four documented keys even if given a richer object', () => {
    const s = memoryStorage();
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    store.save({ ...CRED, token: 'secret-token' } as typeof CRED);
    expect(s.getItem(CREDENTIAL_KEY)).not.toContain('secret-token');
  });

  it('keeps slots isolated under their own keys', () => {
    const s = memoryStorage();
    const a = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    const b = createCredentialStore({ xmppDomain: DOMAIN, slot: 'b', storage: () => s });
    b.save(CRED);
    expect(s.getItem('nearby.identity.v1.b')).not.toBeNull();
    expect(a.load()).toBeNull();
    a.save({ ...CRED, nickname: 'Other' });
    expect(b.load()?.nickname).toBe('Alice_1');
    expect(a.load()?.nickname).toBe('Other');
  });

  it('returns null when nothing is stored', () => {
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => memoryStorage() });
    expect(store.load()).toBeNull();
  });

  it.each<[string, string]>([
    ['non-JSON', 'not json'],
    ['an array', JSON.stringify([STORED])],
    ['null', 'null'],
    ['v 2', JSON.stringify({ ...STORED, v: 2 })],
    ['an extra key', JSON.stringify({ ...STORED, token: 'x' })],
    ['a missing key', JSON.stringify({ v: 1, jid: JID, nickname: 'Alice_1' })],
    ['a foreign domain', JSON.stringify({ ...STORED, jid: `u${'a'.repeat(32)}@evil.example` })],
    ['a bad password', JSON.stringify({ ...STORED, xmppPassword: 'xp1_short' })],
    ['a bad nickname', JSON.stringify({ ...STORED, nickname: '_x' })],
  ])('treats %s as absent and leaves the entry in place', (_name, raw) => {
    const s = memoryStorage();
    s.setItem(CREDENTIAL_KEY, raw);
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    expect(store.load()).toBeNull();
    expect(s.getItem(CREDENTIAL_KEY)).toBe(raw);
  });

  it('reports a setItem failure as not ok', () => {
    const s = memoryStorage();
    s.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    expect(store.save(CRED)).toEqual({ ok: false });
  });

  it('survives a storage getter that throws', () => {
    const store = createCredentialStore({
      xmppDomain: DOMAIN,
      slot: null,
      storage: () => {
        throw new Error('denied');
      },
    });
    expect(store.load()).toBeNull();
    expect(store.save(CRED)).toEqual({ ok: false });
    expect(store.clear()).toBe(false);
  });

  it('handles missing storage', () => {
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => null });
    expect(store.load()).toBeNull();
    expect(store.save(CRED)).toEqual({ ok: false });
    expect(store.clear()).toBe(false);
  });

  it('clear removes only its own key', () => {
    const s = memoryStorage();
    s.setItem('other', '1');
    const a = createCredentialStore({ xmppDomain: DOMAIN, slot: null, storage: () => s });
    const b = createCredentialStore({ xmppDomain: DOMAIN, slot: 'b', storage: () => s });
    a.save(CRED);
    b.save(CRED);
    expect(a.clear()).toBe(true);
    expect(s.getItem(CREDENTIAL_KEY)).toBeNull();
    expect(s.getItem('nearby.identity.v1.b')).not.toBeNull();
    expect(s.getItem('other')).toBe('1');
  });

  it('uses window.localStorage by default', () => {
    const store = createCredentialStore({ xmppDomain: DOMAIN, slot: 'dflt' });
    try {
      expect(store.save(CRED)).toEqual({ ok: true });
      expect(window.localStorage.getItem('nearby.identity.v1.dflt')).not.toBeNull();
      expect(store.load()).toEqual(CRED);
    } finally {
      store.clear();
    }
  });
});
