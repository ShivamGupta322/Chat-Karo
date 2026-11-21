import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttp, type FetchLike, type HttpResponseLike } from '../../src/api/http';

function res(status: number, text: string, headers: Record<string, string> = {}): HttpResponseLike {
  return {
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(text),
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (c: Call) => Promise<HttpResponseLike>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const c = { url, init };
      calls.push(c);
      return respond(c);
    },
  };
}

/** A fetch that never answers but rejects when its signal aborts, like the real one. */
function hanging(): { fetch: FetchLike; calls: Call[] } {
  return fakeFetch(
    (c) =>
      new Promise<HttpResponseLike>((_resolve, reject) => {
        c.init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  );
}

describe('createHttp.postJson', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts JSON to baseUrl + path with the safe request options', async () => {
    const f = fakeFetch(() => Promise.resolve(res(200, '{"a":1}')));
    const http = createHttp({ baseUrl: '/api', fetch: f.fetch });
    const r = await http.postJson('/session', { nickname: 'Alice' }, { timeoutMs: 1000 });
    expect(r).toEqual({ ok: true, value: { status: 200, body: { a: 1 }, retryAfterMs: null } });
    const call = f.calls[0];
    expect(call?.url).toBe('/api/session');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.cache).toBe('no-store');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(call?.init.body).toBe('{"nickname":"Alice"}');
  });

  it('sends a Bearer header only when a token is given', async () => {
    const f = fakeFetch(() => Promise.resolve(res(200, '{}')));
    const http = createHttp({ baseUrl: '/api', fetch: f.fetch });
    await http.postJson('/x', {}, { timeoutMs: 1000, token: 'tok.en' });
    expect(f.calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer tok.en' });
    await http.postJson('/x', {}, { timeoutMs: 1000 });
    expect(f.calls[1]?.init.headers).not.toHaveProperty('authorization');
  });

  it('maps an empty body to null', async () => {
    const http = createHttp({ baseUrl: '', fetch: fakeFetch(() => Promise.resolve(res(204, ''))).fetch });
    const r = await http.postJson('/x', {}, { timeoutMs: 1000 });
    expect(r).toEqual({ ok: true, value: { status: 204, body: null, retryAfterMs: null } });
  });

  it('treats bad JSON on a 2xx as bad-response and on a 4xx as a null body', async () => {
    const ok = createHttp({ baseUrl: '', fetch: fakeFetch(() => Promise.resolve(res(200, '{nope'))).fetch });
    expect(await ok.postJson('/x', {}, { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: { kind: 'bad-response' },
    });
    const bad = createHttp({ baseUrl: '', fetch: fakeFetch(() => Promise.resolve(res(409, '<html>'))).fetch });
    expect(await bad.postJson('/x', {}, { timeoutMs: 1000 })).toEqual({
      ok: true,
      value: { status: 409, body: null, retryAfterMs: null },
    });
  });

  it('rejects a body over 64 KiB', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(65_536) });
    const http = createHttp({ baseUrl: '', fetch: fakeFetch(() => Promise.resolve(res(200, big))).fetch });
    expect(await http.postJson('/x', {}, { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: { kind: 'bad-response' },
    });
  });

  it.each([
    ['5', 5000],
    ['abc', null],
    ['-1', null],
    ['99999', null],
    ['301', 300_000],
    ['0', 0],
  ])('retry-after %j gives %j', async (value, expected) => {
    const http = createHttp({
      baseUrl: '',
      fetch: fakeFetch(() => Promise.resolve(res(503, '{}', { 'retry-after': value }))).fetch,
    });
    const r = await http.postJson('/x', {}, { timeoutMs: 1000 });
    expect(r.ok && r.value.retryAfterMs).toBe(expected);
  });

  it('gives null when retry-after is missing', async () => {
    const http = createHttp({ baseUrl: '', fetch: fakeFetch(() => Promise.resolve(res(503, '{}'))).fetch });
    const r = await http.postJson('/x', {}, { timeoutMs: 1000 });
    expect(r.ok && r.value.retryAfterMs).toBeNull();
  });

  it('maps a rejected fetch to network', async () => {
    const http = createHttp({ baseUrl: '', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await http.postJson('/x', {}, { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: { kind: 'network' },
    });
  });

  it('times out at exactly timeoutMs and aborts the fetch', async () => {
    const f = hanging();
    const http = createHttp({ baseUrl: '', fetch: f.fetch });
    let settled: unknown = null;
    void http.postJson('/x', {}, { timeoutMs: 15_000 }).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeNull();
    expect(f.calls[0]?.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
  });

  it('times out even when the fetch ignores its signal', async () => {
    const http = createHttp({ baseUrl: '', fetch: () => new Promise<HttpResponseLike>(() => undefined) });
    let settled: unknown = null;
    void http.postJson('/x', {}, { timeoutMs: 1000 }).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('reports an external abort as aborted', async () => {
    const f = hanging();
    const http = createHttp({ baseUrl: '', fetch: f.fetch });
    const ctrl = new AbortController();
    const p = http.postJson('/x', {}, { timeoutMs: 15_000, signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toEqual({ ok: false, error: { kind: 'aborted' } });
  });

  it('does not call fetch for an already-aborted signal', async () => {
    const f = fakeFetch(() => Promise.resolve(res(200, '{}')));
    const http = createHttp({ baseUrl: '', fetch: f.fetch });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await http.postJson('/x', {}, { timeoutMs: 1000, signal: ctrl.signal })).toEqual({
      ok: false,
      error: { kind: 'aborted' },
    });
    expect(f.calls).toHaveLength(0);
  });

  it('leaves no timer and no listener behind after success', async () => {
    const f = fakeFetch(() => Promise.resolve(res(200, '{}')));
    const http = createHttp({ baseUrl: '', fetch: f.fetch });
    const ctrl = new AbortController();
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    await http.postJson('/x', {}, { timeoutMs: 15_000, signal: ctrl.signal });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('never throws, even when fetch throws synchronously', async () => {
    const http = createHttp({
      baseUrl: '',
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await http.postJson('/x', {}, { timeoutMs: 1000 })).toEqual({
      ok: false,
      error: { kind: 'network' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the global fetch resolved at call time by default', async () => {
    const spy = vi.fn(() => Promise.resolve(res(200, '{"ok":true}')));
    vi.stubGlobal('fetch', spy);
    try {
      const http = createHttp({ baseUrl: '/api' });
      const r = await http.postJson('/x', {}, { timeoutMs: 1000 });
      expect(r.ok && r.value.body).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
