import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCredential } from '../../src/api/deviceCredential';
import type { ApiError, ApiResult } from '../../src/api/http';
import type { RenewedSession } from '../../src/api/session';
import {
  createTokenManager,
  type OnlineSource,
  type TokenManager,
  type TokenStatus,
} from '../../src/api/tokenManager';

const CRED: DeviceCredential = {
  jid: `u${'a'.repeat(32)}@chaterl.localhost`,
  xmppPassword: `xp1_${'b'.repeat(32)}`,
  nickname: 'Alice_1',
};

const ok = (token: string, expiresIn = 3600): ApiResult<RenewedSession> => ({
  ok: true,
  value: { nickname: 'Alice_1', token, expiresIn },
});
const httpErr = (status: number, retryAfterMs: number | null = null): ApiResult<RenewedSession> => ({
  ok: false,
  error: { kind: 'http', status, code: null, retryAfterMs },
});
const fail = (error: ApiError): ApiResult<RenewedSession> => ({ ok: false, error });

interface RenewCall {
  cred: DeviceCredential;
  signal: AbortSignal | undefined;
  resolve(r: ApiResult<RenewedSession>): void;
}

function setup(
  extra: { renewAtFraction?: number } = {},
): {
  tm: TokenManager;
  calls: RenewCall[];
  net: { online: boolean; listeners: Set<() => void>; fire(): void };
  statuses: TokenStatus[];
} {
  const calls: RenewCall[] = [];
  const net = {
    online: true,
    listeners: new Set<() => void>(),
    fire() {
      for (const l of [...net.listeners]) l();
    },
  };
  const online: OnlineSource = {
    isOnline: () => net.online,
    subscribe: (cb) => {
      net.listeners.add(cb);
      return () => {
        net.listeners.delete(cb);
      };
    },
  };
  const tm = createTokenManager({
    renew: (cred, signal) =>
      new Promise((resolve) => {
        calls.push({ cred, signal, resolve });
      }),
    now: () => Date.now(),
    online,
    ...extra,
  });
  const statuses: TokenStatus[] = [];
  tm.subscribe((s) => statuses.push(s));
  return { tm, calls, net, statuses };
}

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('createTokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adopts an initial token without renewing, then renews at exactly 80%', async () => {
    const { tm, calls } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    expect(tm.getStatus()).toEqual({ kind: 'valid', expiresAt: 1_000_000 + 3_600_000 });
    expect(calls).toHaveLength(0);
    await flush(2_879_999);
    expect(calls).toHaveLength(0);
    await flush(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cred).toEqual(CRED);
  });

  it('renews immediately when started without a token', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    expect(calls).toHaveLength(1);
    expect(tm.getStatus()).toEqual({ kind: 'renewing' });
    calls[0]?.resolve(ok('t1'));
    await flush();
    expect(tm.getStatus().kind).toBe('valid');
    expect(await tm.getToken()).toEqual({ ok: true, token: 't1' });
  });

  it('shares one renew between concurrent getToken calls', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    const all = Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(ok('t1'));
    expect(await all).toEqual([
      { ok: true, token: 't1' },
      { ok: true, token: 't1' },
      { ok: true, token: 't1' },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('returns a token with at least 60 s left and renews with 59 s left', async () => {
    const { tm, calls } = setup({ renewAtFraction: 1 });
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    await flush(3_539_000); // 61 s left
    expect(await tm.getToken()).toEqual({ ok: true, token: 't1' });
    expect(calls).toHaveLength(0);
    await flush(2_000); // 59 s left
    const p = tm.getToken();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(ok('t2'));
    expect(await p).toEqual({ ok: true, token: 't2' });
  });

  it('treats a 401 as identity-invalid: terminal, no more renews', async () => {
    const { tm, calls } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    await flush(2_880_000);
    calls[0]?.resolve(httpErr(401));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'identity-invalid' });
    await flush(600_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await tm.getToken()).toEqual({ ok: false, error: 'identity-invalid' });
    expect(calls).toHaveLength(1);
  });

  it.each([400, 404, 405, 413, 415])('treats a %i as failed: terminal, no retry', async (status) => {
    const { tm, calls } = setup();
    tm.start(CRED);
    calls[0]?.resolve(httpErr(status));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'failed' });
    await flush(600_000);
    expect(calls).toHaveLength(1);
    expect(await tm.getToken()).toEqual({ ok: false, error: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('keeps a still-valid token after a terminal failure', async () => {
    const { tm, calls } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    await flush(2_880_000);
    calls[0]?.resolve(httpErr(404));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'failed' });
    expect(await tm.getToken()).toEqual({ ok: true, token: 't1' });
  });

  it('retries a 503 after max(retry-after, backoff)', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    calls[0]?.resolve(httpErr(503, 20_000));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'retrying', nextAttemptAt: Date.now() + 20_000 });
    await flush(19_999);
    expect(calls).toHaveLength(1);
    await flush(1);
    expect(calls).toHaveLength(2);
  });

  it('backs off 5, 10, 20, 30, 30 s and resets after a success', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    const expectDelay = async (index: number, ms: number): Promise<void> => {
      calls[index]?.resolve(httpErr(503));
      await flush();
      await flush(ms - 1);
      expect(calls).toHaveLength(index + 1);
      await flush(1);
      expect(calls).toHaveLength(index + 2);
    };
    await expectDelay(0, 5_000);
    await expectDelay(1, 10_000);
    await expectDelay(2, 20_000);
    await expectDelay(3, 30_000);
    await expectDelay(4, 30_000);
    calls[5]?.resolve(ok('t1', 3600));
    await flush();
    expect(tm.getStatus().kind).toBe('valid');
    await flush(2_880_000);
    expect(calls).toHaveLength(7); // proactive renew
    await expectDelay(6, 5_000);
  });

  it('retries timeouts and network errors the same way', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    calls[0]?.resolve(fail({ kind: 'timeout' }));
    await flush(5_000);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(fail({ kind: 'network' }));
    await flush(9_999);
    expect(calls).toHaveLength(2);
    await flush(1);
    expect(calls).toHaveLength(3);
    calls[2]?.resolve(fail({ kind: 'bad-response' }));
    await flush(20_000);
    expect(calls).toHaveLength(4);
  });

  it('goes offline without a timer when a failure happens offline, and renews at once on online', async () => {
    const { tm, calls, net } = setup();
    tm.start(CRED);
    net.online = false;
    calls[0]?.resolve(fail({ kind: 'network' }));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'offline' });
    expect(vi.getTimerCount()).toBe(0);
    await flush(120_000);
    expect(calls).toHaveLength(1);
    net.online = true;
    net.fire();
    expect(calls).toHaveLength(2);
  });

  it('does not fetch from the proactive timer while offline', async () => {
    const { tm, calls, net } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    net.online = false;
    await flush(2_880_000);
    expect(calls).toHaveLength(0);
    expect(tm.getStatus()).toEqual({ kind: 'offline' });
    net.online = true;
    net.fire();
    expect(calls).toHaveLength(1);
  });

  it('renews at once on online while retrying, and ignores online while valid', async () => {
    const { tm, calls, net } = setup();
    tm.start(CRED);
    calls[0]?.resolve(httpErr(503));
    await flush();
    expect(tm.getStatus().kind).toBe('retrying');
    net.fire();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(ok('t1'));
    await flush();
    net.fire();
    expect(calls).toHaveLength(2);
  });

  it('does not renew on start while offline, then does on online', () => {
    const { tm, calls, net } = setup();
    net.online = false;
    tm.start(CRED);
    expect(calls).toHaveLength(0);
    expect(tm.getStatus()).toEqual({ kind: 'offline' });
    net.online = true;
    net.fire();
    expect(calls).toHaveLength(1);
  });

  it('getToken during a backoff wait renews at once and cancels the wait', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    calls[0]?.resolve(httpErr(503));
    await flush();
    expect(tm.getStatus().kind).toBe('retrying');
    const p = tm.getToken();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(ok('t1'));
    expect(await p).toEqual({ ok: true, token: 't1' });
    await flush(30_000);
    expect(calls).toHaveLength(2);
  });

  it('stop() aborts an in-flight renew and ignores its late result', async () => {
    const { tm, calls, statuses } = setup();
    tm.start(CRED);
    const p = tm.getToken();
    tm.stop();
    expect(calls[0]?.signal?.aborted).toBe(true);
    calls[0]?.resolve(ok('late'));
    expect(await p).toEqual({ ok: false, error: 'stopped' });
    expect(tm.getStatus()).toEqual({ kind: 'idle' });
    expect(statuses.some((s) => s.kind === 'valid')).toBe(false);
    expect(await tm.getToken()).toEqual({ ok: false, error: 'stopped' });
  });

  it('ignores a result from an old generation after stop() then start()', async () => {
    const { tm, calls } = setup();
    tm.start(CRED);
    tm.stop();
    tm.start({ ...CRED, nickname: 'Other' });
    expect(calls).toHaveLength(2);
    calls[0]?.resolve(ok('old'));
    await flush();
    expect(tm.getStatus()).toEqual({ kind: 'renewing' });
    calls[1]?.resolve(ok('new'));
    await flush();
    expect(await tm.getToken()).toEqual({ ok: true, token: 'new' });
  });

  it('stop() removes the online listener and clears every timer', async () => {
    const { tm, calls, net } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    expect(net.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    tm.stop();
    expect(net.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await flush(4_000_000);
    expect(calls).toHaveLength(0);
  });

  it('start() twice never leaves two online listeners', () => {
    const { tm, net } = setup();
    tm.start(CRED, { token: 't1', expiresIn: 3600 });
    tm.start(CRED, { token: 't2', expiresIn: 3600 });
    expect(net.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  describe('withToken', () => {
    const unauthorized: ApiResult<string> = {
      ok: false,
      error: { kind: 'http', status: 401, code: null, retryAfterMs: null },
    };

    it('passes a 200 through', async () => {
      const { tm } = setup();
      tm.start(CRED, { token: 't1', expiresIn: 3600 });
      const call = vi.fn<(t: string) => Promise<ApiResult<string>>>(() => Promise.resolve({ ok: true, value: 'x' }));
      expect(await tm.withToken(call)).toEqual({ ok: true, value: 'x' });
      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith('t1');
    });

    it('passes a non-401 error through without renewing', async () => {
      const { tm, calls } = setup();
      tm.start(CRED, { token: 't1', expiresIn: 3600 });
      const err: ApiResult<string> = {
        ok: false,
        error: { kind: 'http', status: 503, code: null, retryAfterMs: null },
      };
      expect(await tm.withToken(() => Promise.resolve(err))).toEqual(err);
      expect(calls).toHaveLength(0);
    });

    it('on a 401 renews once and retries once with the new token', async () => {
      const { tm, calls } = setup();
      tm.start(CRED, { token: 't1', expiresIn: 3600 });
      const call = vi
        .fn<(t: string) => Promise<ApiResult<string>>>()
        .mockResolvedValueOnce(unauthorized)
        .mockResolvedValueOnce({ ok: true, value: 'x' });
      const p = tm.withToken(call);
      await flush();
      expect(calls).toHaveLength(1);
      calls[0]?.resolve(ok('t2'));
      expect(await p).toEqual({ ok: true, value: 'x' });
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[0]?.[0]).toBe('t1');
      expect(call.mock.calls[1]?.[0]).toBe('t2');
    });

    it('answers unauthorized after a second 401, with exactly one renew', async () => {
      const { tm, calls } = setup();
      tm.start(CRED, { token: 't1', expiresIn: 3600 });
      const call = vi.fn<(t: string) => Promise<ApiResult<string>>>(() => Promise.resolve(unauthorized));
      const p = tm.withToken(call);
      await flush();
      calls[0]?.resolve(ok('t2'));
      expect(await p).toEqual({ ok: false, error: { kind: 'unauthorized' } });
      expect(call).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(1);
    });

    it('reports a token failure without calling', async () => {
      const { tm, calls } = setup();
      tm.start(CRED);
      calls[0]?.resolve(httpErr(401));
      await flush();
      const call = vi.fn<(t: string) => Promise<ApiResult<string>>>(() => Promise.resolve({ ok: true, value: 'x' }));
      expect(await tm.withToken(call)).toEqual({
        ok: false,
        error: { kind: 'token', reason: 'identity-invalid' },
      });
      expect(call).not.toHaveBeenCalled();
    });
  });

  it('never exposes the token in status objects or subscriber payloads', async () => {
    const { tm, calls, statuses } = setup();
    tm.start(CRED, { token: 'SECRET.TOKEN.VALUE', expiresIn: 3600 });
    await flush(2_880_000);
    calls[0]?.resolve(ok('ANOTHER.SECRET.VALUE'));
    await flush();
    calls.length = 0;
    const seen = JSON.stringify([...statuses, tm.getStatus()]);
    expect(seen).not.toContain('SECRET');
    expect(statuses.length).toBeGreaterThan(2);
  });

  it('does not throw when the renew function throws', async () => {
    const tm = createTokenManager({
      renew: () => Promise.reject(new Error('boom')),
      now: () => Date.now(),
      online: { isOnline: () => true, subscribe: () => () => undefined },
    });
    tm.start(CRED);
    await flush();
    expect(tm.getStatus().kind).toBe('retrying');
    tm.stop();
  });
});
