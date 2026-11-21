// Keeps a memory-only API token valid (ADR-019 D2). The token never appears in status, events or errors.
import type { DeviceCredential } from './deviceCredential';
import type { ApiResult, Timers } from './http';
import type { SessionApi } from './session';

export type TokenStatus =
  | { kind: 'idle' }
  | { kind: 'renewing' }
  | { kind: 'valid'; expiresAt: number }
  | { kind: 'retrying'; nextAttemptAt: number }
  | { kind: 'offline' }
  | { kind: 'identity-invalid' }
  | { kind: 'failed' };

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; error: 'stopped' | 'offline' | 'identity-invalid' | 'unavailable' };

export type WithTokenResult<T> =
  | ApiResult<T>
  | {
      ok: false;
      error:
        | { kind: 'token'; reason: Exclude<TokenResult, { ok: true }>['error'] }
        | { kind: 'unauthorized' };
    };

export interface TokenAccess {
  /** A token with at least 60 s left, else a single-flight renew. */
  getToken(): Promise<TokenResult>;
  /** call(token); on http 401 drop that token, renew once and retry once; a second 401 gives { kind: 'unauthorized' }. */
  withToken<T>(call: (token: string) => Promise<ApiResult<T>>): Promise<WithTokenResult<T>>;
  getStatus(): TokenStatus;
  subscribe(l: (s: TokenStatus) => void): () => void;
}

export interface TokenManager extends TokenAccess {
  start(c: DeviceCredential, initial?: { token: string; expiresIn: number }): void;
  stop(): void;
}

export interface OnlineSource {
  isOnline(): boolean;
  subscribe(cb: () => void): () => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (h) => {
    globalThis.clearTimeout(h);
  },
};

const defaultOnline: OnlineSource = {
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
  subscribe: (cb) => {
    window.addEventListener('online', cb);
    return () => {
      window.removeEventListener('online', cb);
    };
  },
};

// Renew answers that retrying cannot fix. 404 is what a stale geo_service image returns.
const TERMINAL_HTTP = new Set([400, 404, 405, 413, 415]);

export function createTokenManager(o: {
  renew: SessionApi['renew'];
  now?: () => number;
  timers?: Timers;
  online?: OnlineSource;
  renewAtFraction?: number;
  minValidityMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}): TokenManager {
  const now = o.now ?? ((): number => Date.now());
  const timers = o.timers ?? defaultTimers;
  const online = o.online ?? defaultOnline;
  const fraction = o.renewAtFraction ?? 0.8;
  const minValidityMs = o.minValidityMs ?? 60_000;
  const backoffBaseMs = o.backoffBaseMs ?? 5_000;
  const backoffMaxMs = o.backoffMaxMs ?? 30_000;

  let generation = 0;
  let cred: DeviceCredential | null = null;
  let token: string | null = null;
  let expiresAt = 0;
  let status: TokenStatus = { kind: 'idle' };
  let inflight: Promise<TokenResult> | null = null;
  let abort: AbortController | null = null;
  let proactiveTimer: ReturnType<Timers['set']> | null = null;
  let retryTimer: ReturnType<Timers['set']> | null = null;
  let attempt = 0;
  let offlineUnsub: (() => void) | null = null;
  const listeners = new Set<(s: TokenStatus) => void>();

  function setStatus(s: TokenStatus): void {
    status = s;
    for (const l of [...listeners]) l(s);
  }

  function clearTimers(): void {
    if (proactiveTimer !== null) timers.clear(proactiveTimer);
    if (retryTimer !== null) timers.clear(retryTimer);
    proactiveTimer = null;
    retryTimer = null;
  }

  function adopt(t: string, expiresIn: number): void {
    clearTimers();
    token = t;
    expiresAt = now() + expiresIn * 1000;
    attempt = 0;
    proactiveTimer = timers.set(onProactive, Math.round(expiresIn * 1000 * fraction));
    setStatus({ kind: 'valid', expiresAt });
  }

  function scheduleRetry(retryAfterMs: number | null): void {
    if (!online.isOnline()) {
      setStatus({ kind: 'offline' });
      return;
    }
    const backoff = Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs);
    const delay = Math.max(retryAfterMs ?? 0, backoff);
    attempt += 1;
    setStatus({ kind: 'retrying', nextAttemptAt: now() + delay });
    retryTimer = timers.set(onRetry, delay);
  }

  function onProactive(): void {
    proactiveTimer = null;
    if (cred === null) return;
    if (!online.isOnline()) {
      setStatus({ kind: 'offline' });
      return;
    }
    void renewNow();
  }

  function onRetry(): void {
    retryTimer = null;
    if (cred === null) return;
    if (!online.isOnline()) {
      setStatus({ kind: 'offline' });
      return;
    }
    void renewNow();
  }

  function onOnline(): void {
    if (cred === null) return;
    if (status.kind === 'offline' || status.kind === 'retrying') void renewNow();
  }

  function handleResult(r: ApiResult<{ token: string; expiresIn: number }>): TokenResult {
    if (r.ok) {
      adopt(r.value.token, r.value.expiresIn);
      return { ok: true, token: r.value.token };
    }
    const e = r.error;
    if (e.kind === 'http' && e.status === 401) {
      clearTimers();
      token = null;
      expiresAt = 0;
      setStatus({ kind: 'identity-invalid' });
      return { ok: false, error: 'identity-invalid' };
    }
    if (e.kind === 'http' && TERMINAL_HTTP.has(e.status)) {
      // A still-unexpired token stays usable until it expires; nothing is retried.
      clearTimers();
      setStatus({ kind: 'failed' });
      return { ok: false, error: 'unavailable' };
    }
    scheduleRetry(e.kind === 'http' ? e.retryAfterMs : null);
    return { ok: false, error: online.isOnline() ? 'unavailable' : 'offline' };
  }

  function renewNow(): Promise<TokenResult> {
    if (inflight !== null) return inflight;
    const c = cred;
    if (c === null) return Promise.resolve({ ok: false, error: 'stopped' });
    if (retryTimer !== null) timers.clear(retryTimer);
    retryTimer = null;
    const myGeneration = generation;
    const ctrl = new AbortController();
    abort = ctrl;
    setStatus({ kind: 'renewing' });
    const p = (async (): Promise<TokenResult> => {
      let r: ApiResult<{ token: string; expiresIn: number }>;
      try {
        r = await o.renew(c, ctrl.signal);
      } catch {
        r = { ok: false, error: { kind: 'network' } };
      }
      if (myGeneration !== generation) return { ok: false, error: 'stopped' };
      inflight = null;
      abort = null;
      return handleResult(r);
    })();
    inflight = p;
    return p;
  }

  function dropToken(t: string): void {
    if (token === t) {
      token = null;
      expiresAt = 0;
    }
  }

  async function getToken(): Promise<TokenResult> {
    if (cred === null) return { ok: false, error: 'stopped' };
    if (status.kind === 'identity-invalid') return { ok: false, error: 'identity-invalid' };
    if (token !== null && expiresAt - now() >= minValidityMs) return { ok: true, token };
    if (status.kind === 'failed') return { ok: false, error: 'unavailable' };
    if (inflight === null && !online.isOnline()) {
      setStatus({ kind: 'offline' });
      return { ok: false, error: 'offline' };
    }
    // A user-driven call skips any backoff wait (renewNow cancels the retry timer).
    return renewNow();
  }

  function isUnauthorized(r: ApiResult<unknown>): boolean {
    return !r.ok && r.error.kind === 'http' && r.error.status === 401;
  }

  function stop(): void {
    generation += 1;
    abort?.abort();
    abort = null;
    inflight = null;
    clearTimers();
    token = null;
    expiresAt = 0;
    cred = null;
    attempt = 0;
    offlineUnsub?.();
    offlineUnsub = null;
    setStatus({ kind: 'idle' });
  }

  return {
    start(c, initial) {
      stop();
      cred = c;
      offlineUnsub = online.subscribe(onOnline);
      if (initial !== undefined) {
        adopt(initial.token, initial.expiresIn);
      } else if (online.isOnline()) {
        void renewNow();
      } else {
        setStatus({ kind: 'offline' });
      }
    },
    stop,
    getToken,
    async withToken<T>(call: (token: string) => Promise<ApiResult<T>>): Promise<WithTokenResult<T>> {
      const first = await getToken();
      if (!first.ok) return { ok: false, error: { kind: 'token', reason: first.error } };
      const r1 = await call(first.token);
      if (!isUnauthorized(r1)) return r1;
      dropToken(first.token);
      const second = await getToken();
      if (!second.ok) return { ok: false, error: { kind: 'token', reason: second.error } };
      const r2 = await call(second.token);
      if (isUnauthorized(r2)) return { ok: false, error: { kind: 'unauthorized' } };
      return r2;
    },
    getStatus: () => status,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
