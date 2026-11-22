import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult, Http, HttpResponse, PostOptions } from '../../src/api/http';
import { createLocateApi, LOCATE_TIMEOUT_MS, type LocateResult } from '../../src/api/locate';
import {
  createTokenManager,
  type TokenAccess,
  type WithTokenResult,
} from '../../src/api/tokenManager';

const MUC = 'muc.chaterl.localhost';
// The centre of u4pruyd (hard-coded oracle).
// The shortest round-trip form of the double; the lint rule wants 17 significant digits.
// eslint-disable-next-line no-loss-of-precision
const POINT = { lat: 57.64869689941406, lng: 10.407485961914062 };
const GOOD = {
  cell: 'u4pruyd',
  precision: 7,
  range: 'block',
  room_jid: `g7_u4pruyd@${MUC}`,
};

const respond = (
  status: number,
  body: unknown,
  retryAfterMs: number | null = null,
): ApiResult<HttpResponse> => ({
  ok: true,
  value: { status, body, retryAfterMs },
});

interface Call {
  path: string;
  body: unknown;
  opts: PostOptions;
}

function fakeHttp(results: ApiResult<HttpResponse>[] | ApiResult<HttpResponse>): {
  http: Http;
  calls: Call[];
} {
  const queue = Array.isArray(results) ? [...results] : null;
  const calls: Call[] = [];
  return {
    calls,
    http: {
      postJson: (path, body, opts) => {
        calls.push({ path, body, opts });
        const next = queue === null ? (results as ApiResult<HttpResponse>) : queue.shift();
        return Promise.resolve(next ?? respond(500, null));
      },
    },
  };
}

/** A token source that calls straight through, or answers a fixed failure. */
function fakeTokens(fixed?: WithTokenResult<never>): TokenAccess {
  return {
    getToken: () => Promise.resolve({ ok: true, token: 'tok' }),
    withToken: async <T,>(
      call: (t: string) => Promise<ApiResult<T>>,
    ): Promise<WithTokenResult<T>> => fixed ?? (await call('tok')),
    getStatus: () => ({ kind: 'idle' }),
    subscribe: () => () => undefined,
  };
}

const signal = new AbortController().signal;

async function run(
  r: ApiResult<HttpResponse>,
  tokens: TokenAccess = fakeTokens(),
): Promise<LocateResult> {
  const { http } = fakeHttp(r);
  return createLocateApi({ http, tokens, mucDomain: MUC }).locate(POINT, signal);
}

const BAD = { ok: false, error: { kind: 'bad-response' } };

describe('createLocateApi request', () => {
  it('posts /locate with the timeout, the signal, the token and exactly {lat, lng}', async () => {
    const { http, calls } = fakeHttp(respond(200, GOOD));
    const ctrl = new AbortController();
    const r = await createLocateApi({ http, tokens: fakeTokens(), mucDomain: MUC }).locate(
      POINT,
      ctrl.signal,
    );
    expect(r).toEqual({
      ok: true,
      value: { cell: 'u4pruyd', precision: 7, range: 'block', roomJid: `g7_u4pruyd@${MUC}` },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/locate');
    expect(calls[0]?.opts).toEqual({ timeoutMs: 10_000, token: 'tok', signal: ctrl.signal });
    expect(LOCATE_TIMEOUT_MS).toBe(10_000);
    expect(Object.keys(calls[0]?.body as object)).toEqual(['lat', 'lng']);
    expect(JSON.stringify(calls[0]?.body)).toBe(
      '{"lat":57.64869689941406,"lng":10.407485961914062}',
    );
  });

  it('never forwards extra keys (accuracy, range) carried by the input', async () => {
    const { http, calls } = fakeHttp(respond(200, GOOD));
    const sneaky = { ...POINT, accuracy: 5, range: 'area' } as typeof POINT;
    await createLocateApi({ http, tokens: fakeTokens(), mucDomain: MUC }).locate(sneaky, signal);
    expect(Object.keys(calls[0]?.body as object)).toEqual(['lat', 'lng']);
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/accuracy|range/);
  });
});

describe('createLocateApi validation', () => {
  it('tolerates extra keys', async () => {
    expect((await run(respond(200, { ...GOOD, extra: 1 }))).ok).toBe(true);
  });

  it.each([
    [
      'neighbourhood',
      { cell: 'u4pruy', precision: 6, range: 'neighbourhood', room_jid: `g6_u4pruy@${MUC}` },
    ],
    ['area', { cell: 'u4pru', precision: 5, range: 'area', room_jid: `g5_u4pru@${MUC}` }],
  ])('accepts a valid %s answer', async (_n, body) => {
    expect((await run(respond(200, body))).ok).toBe(true);
  });

  it.each(['cell', 'precision', 'range', 'room_jid'])(
    'rejects an answer without %s',
    async (key) => {
      const body: Record<string, unknown> = { ...GOOD };
      delete body[key];
      expect(await run(respond(200, body))).toEqual(BAD);
    },
  );

  it.each([
    ['precision 4', { precision: 4 }],
    ['precision 8', { precision: 8 }],
    ["precision '7'", { precision: '7' }],
    ['precision 7.5', { precision: 7.5 }],
    ['US spelling', { range: 'neighborhood' }],
    ['area with precision 7', { range: 'area' }],
    ['a cell with a', { cell: 'u4pruya', room_jid: `g7_u4pruya@${MUC}` }],
    ['a cell with i', { cell: 'u4pruyi', room_jid: `g7_u4pruyi@${MUC}` }],
    ['a cell with l', { cell: 'u4pruyl', room_jid: `g7_u4pruyl@${MUC}` }],
    ['a cell with o', { cell: 'u4pruyo', room_jid: `g7_u4pruyo@${MUC}` }],
    ['an uppercase cell', { cell: 'U4pruyd', room_jid: `g7_U4pruyd@${MUC}` }],
    ['a cell of the wrong length', { cell: 'u4pruy', room_jid: `g7_u4pruy@${MUC}` }],
    ['a foreign domain', { room_jid: 'g7_u4pruyd@muc.evil.example' }],
    ['a resource', { room_jid: `g7_u4pruyd@${MUC}/nick` }],
    ['a g6_ prefix for precision 7', { room_jid: `g6_u4pruyd@${MUC}` }],
    ['a different cell', { room_jid: `g7_u4pruye@${MUC}` }],
    ['a look-alike domain', { room_jid: 'g7_u4pruyd@mucXchaterl.localhost' }],
  ])('rejects %s', async (_n, patch) => {
    expect(await run(respond(200, { ...GOOD, ...patch }))).toEqual(BAD);
  });

  it.each([
    ['null', null],
    ['an array', [GOOD]],
    ['a string', 'x'],
  ])('rejects a %s body', async (_n, body) => {
    expect(await run(respond(200, body))).toEqual(BAD);
  });

  it('rejects a 201', async () => {
    expect(await run(respond(201, GOOD))).toEqual(BAD);
  });
});

describe('createLocateApi error mapping', () => {
  it.each([500, 502, 503, 504])('http %d -> unavailable carrying retryAfterMs', async (status) => {
    expect(await run(respond(status, { error: 'x' }, 5000))).toEqual({
      ok: false,
      error: { kind: 'unavailable', retryAfterMs: 5000 },
    });
  });

  it('http 503 without retry-after -> unavailable (null)', async () => {
    expect(await run(respond(503, null))).toEqual({
      ok: false,
      error: { kind: 'unavailable', retryAfterMs: null },
    });
  });

  it.each([
    ['timeout', { kind: 'timeout' }],
    ['network', { kind: 'network' }],
  ] as const)('%s -> unavailable (null)', async (_n, error) => {
    expect(await run({ ok: false, error })).toEqual({
      ok: false,
      error: { kind: 'unavailable', retryAfterMs: null },
    });
  });

  it.each(['unavailable', 'stopped'] as const)(
    'token reason %s -> unavailable (null)',
    async (reason) => {
      const tokens = fakeTokens({ ok: false, error: { kind: 'token', reason } });
      expect(await run(respond(200, GOOD), tokens)).toEqual({
        ok: false,
        error: { kind: 'unavailable', retryAfterMs: null },
      });
    },
  );

  it('token reason offline -> offline', async () => {
    const tokens = fakeTokens({ ok: false, error: { kind: 'token', reason: 'offline' } });
    expect(await run(respond(200, GOOD), tokens)).toEqual({
      ok: false,
      error: { kind: 'offline' },
    });
  });

  it('token reason identity-invalid -> identity-invalid', async () => {
    const tokens = fakeTokens({ ok: false, error: { kind: 'token', reason: 'identity-invalid' } });
    expect(await run(respond(200, GOOD), tokens)).toEqual({
      ok: false,
      error: { kind: 'identity-invalid' },
    });
  });

  it('unauthorized -> bad-response', async () => {
    const tokens = fakeTokens({ ok: false, error: { kind: 'unauthorized' } });
    expect(await run(respond(200, GOOD), tokens)).toEqual(BAD);
  });

  it.each([400, 401, 404, 405, 413, 415, 429])('http %d -> bad-response', async (status) => {
    // 401 reaches here only through a token source that does not retry.
    expect(await run(respond(status, { error: 'invalid_location' }))).toEqual(BAD);
  });

  it('a non-200 2xx -> bad-response', async () => {
    expect(await run(respond(204, null))).toEqual(BAD);
  });

  it('http bad-response -> bad-response', async () => {
    expect(await run({ ok: false, error: { kind: 'bad-response' } })).toEqual(BAD);
  });

  it('aborted -> aborted', async () => {
    expect(await run({ ok: false, error: { kind: 'aborted' } })).toEqual({
      ok: false,
      error: { kind: 'aborted' },
    });
  });

  it('never rejects, even when the token source throws', async () => {
    const tokens: TokenAccess = {
      ...fakeTokens(),
      withToken: () => Promise.reject(new Error('boom')),
    };
    expect(await run(respond(200, GOOD), tokens)).toEqual(BAD);
  });
});

describe('createLocateApi with the real token manager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Renewed = ApiResult<{ nickname: string; token: string; expiresIn: number }>;
  const CRED = {
    jid: `u${'a'.repeat(32)}@chaterl.localhost`,
    xmppPassword: `xp1_${'b'.repeat(32)}`,
    nickname: 'Alice_1',
  };

  function setup(
    httpResults: ApiResult<HttpResponse>[],
    renewResults: Renewed[],
  ): { locate: ReturnType<typeof createLocateApi>; calls: Call[]; renews: { n: number } } {
    const { http, calls } = fakeHttp(httpResults);
    const renews = { n: 0 };
    const tokens = createTokenManager({
      renew: () => {
        renews.n += 1;
        return Promise.resolve(renewResults.shift() ?? { ok: false, error: { kind: 'network' } });
      },
      online: { isOnline: () => true, subscribe: () => () => undefined },
    });
    tokens.start(CRED, { token: 'first', expiresIn: 3600 });
    return { locate: createLocateApi({ http, tokens, mucDomain: MUC }), calls, renews };
  }

  const unauthorized = respond(401, { error: 'unauthorized' });
  const renewed = (token: string): Renewed => ({
    ok: true,
    value: { nickname: 'Alice_1', token, expiresIn: 3600 },
  });

  it('401 -> renew -> 200: ok with two locate calls and one renew', async () => {
    const { locate, calls, renews } = setup(
      [unauthorized, respond(200, GOOD)],
      [renewed('second')],
    );
    expect((await locate.locate(POINT, signal)).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.opts.token)).toEqual(['first', 'second']);
    expect(renews.n).toBe(1);
  });

  it('401 twice -> bad-response, no third call', async () => {
    const { locate, calls } = setup(
      [unauthorized, unauthorized, respond(200, GOOD)],
      [renewed('second')],
    );
    expect(await locate.locate(POINT, signal)).toEqual(BAD);
    expect(calls).toHaveLength(2);
  });

  it('a renew 401 -> identity-invalid', async () => {
    const { locate, calls } = setup(
      [unauthorized],
      [{ ok: false, error: { kind: 'http', status: 401, code: 'unauthorized', retryAfterMs: null } }],
    );
    expect(await locate.locate(POINT, signal)).toEqual({
      ok: false,
      error: { kind: 'identity-invalid' },
    });
    expect(calls).toHaveLength(1);
  });
});

describe('createLocateApi is silent', () => {
  it('makes no console calls on success or failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await run(respond(200, GOOD));
    await run(respond(503, null));
    await run(respond(200, { ...GOOD, cell: 'bad' }));
    await run({ ok: false, error: { kind: 'network' } });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
