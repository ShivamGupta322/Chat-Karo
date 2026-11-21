// The only file that touches browser storage (lint-enforced). The API token is never stored: the type has no field for it.
import { isValidNickname, isValidPassword, jidPattern } from './identityRules';

export interface DeviceCredential {
  jid: string;
  xmppPassword: string;
  nickname: string;
}
export const CREDENTIAL_KEY = 'nearby.identity.v1';

export interface CredentialStore {
  /** The stored credential, or null when absent or malformed. A malformed entry is left in place. */
  load(): DeviceCredential | null;
  save(c: DeviceCredential): { ok: boolean };
  clear(): boolean;
}

const defaultStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    // Safari private mode and disabled storage throw on access.
    return null;
  }
};

const KEYS = ['jid', 'nickname', 'v', 'xmppPassword'].join();

export function createCredentialStore(o: {
  xmppDomain: string;
  slot: string | null;
  storage?: () => Storage | null;
}): CredentialStore {
  const getStorage = o.storage ?? defaultStorage;
  const key = o.slot === null ? CREDENTIAL_KEY : `${CREDENTIAL_KEY}.${o.slot}`;
  const jidRe = jidPattern(o.xmppDomain);

  const storage = (): Storage | null => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };

  return {
    load() {
      try {
        const s = storage();
        if (s === null) return null;
        const raw = s.getItem(key);
        if (raw === null) return null;
        const v: unknown = JSON.parse(raw);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
        if (Object.keys(v).sort().join() !== KEYS) return null;
        const r = v as Record<string, unknown>;
        if (
          r.v !== 1 ||
          typeof r.jid !== 'string' ||
          !jidRe.test(r.jid) ||
          !isValidPassword(r.xmppPassword) ||
          !isValidNickname(r.nickname)
        ) {
          return null;
        }
        return { jid: r.jid, xmppPassword: r.xmppPassword, nickname: r.nickname };
      } catch {
        return null;
      }
    },
    save(c) {
      try {
        const s = storage();
        if (s === null) return { ok: false };
        s.setItem(
          key,
          JSON.stringify({ v: 1, jid: c.jid, xmppPassword: c.xmppPassword, nickname: c.nickname }),
        );
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    clear() {
      try {
        const s = storage();
        if (s === null) return false;
        s.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
