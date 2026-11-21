import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, Http, HttpResponse, PostOptions } from '../../src/api/http';
import { createSessionApi } from '../../src/api/session';

const DOMAIN = 'chaterl.localhost';
const JID = `u${'0123456789abcdef'.repeat(2)}@${DOMAIN}`;
const PASSWORD = `xp1_${'A1_-'.repeat(8)}`;
const GOOD = {
  jid: JID,
  xmpp_password: PASSWORD,
  nickname: 'Alice_1',
  token: 'aaa.bbb.ccc',
  token_type: 'Bearer',
  expires_in: 3600,
};

function fakeHttp(result: ApiResult<HttpResponse>): {
  http: Http;
  calls: { path: string; body: unknown; opts: PostOptions }[];
} {
  const calls: { path: string; body: unknown; opts: PostOptions }[] = [];
  return {
    calls,
    http: {
      postJson: (path, body, opts) => {
        calls.push({ path, body, opts });
        return Promise.resolve(result);
      },
    },
  };
}

const respond = (status: number, body: unknown, retryAfterMs: number | null = null): ApiResult<HttpResponse> => ({
  ok: true,
  value: { status, body, retryAfterMs },
});

describe('createSessionApi.create', () => {
  it('maps a 201 to the credential, token and expiry', async () => {
    const { http, calls } = fakeHttp(respond(201, GOOD));
    const r = await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1');
    expect(r).toEqual({
      ok: true,
      value: {
        credential: { jid: JID, xmppPassword: PASSWORD, nickname: 'Alice_1' },
        token: 'aaa.bbb.ccc',
        expiresIn: 3600,
      },
    });
    expect(calls[0]?.path).toBe('/session');
    expect(calls[0]?.body).toEqual({ nickname: 'Alice_1' });
    expect(calls[0]?.opts.timeoutMs).toBe(15_000);
  });

  it('treats a 200 as bad-response', async () => {
    const { http } = fakeHttp(respond(200, GOOD));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).toEqual({
      ok: false,
      error: { kind: 'bad-response' },
    });
  });

  it.each([
    ['another domain', { jid: `u${'a'.repeat(32)}@evil.example` }],
    ['uppercase hex', { jid: `u${'A'.repeat(32)}@${DOMAIN}` }],
    ['a resource', { jid: `${JID}/r1` }],
    ['a 31 character password', { xmpp_password: `xp1_${'a'.repeat(31)}` }],
    ['a bad nickname', { nickname: '_x' }],
    ['no token', { token: undefined }],
    ['a bad token character', { token: 'a b' }],
    ['lowercase bearer', { token_type: 'bearer' }],
    ['expires_in 0', { expires_in: 0 }],
    ['expires_in 3600.5', { expires_in: 3600.5 }],
    ['expires_in over a day', { expires_in: 86_401 }],
    ['a string expires_in', { expires_in: '3600' }],
  ])('rejects a 201 with %s', async (_name, patch) => {
    const { http } = fakeHttp(respond(201, { ...GOOD, ...patch }));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).toEqual({
      ok: false,
      error: { kind: 'bad-response' },
    });
  });

  it.each([null, 'text', [GOOD]])('rejects a non-object body %j', async (body) => {
    const { http } = fakeHttp(respond(201, body));
    const r = await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1');
    expect(r).toEqual({ ok: false, error: { kind: 'bad-response' } });
  });

  it('tolerates extra keys', async () => {
    const { http } = fakeHttp(respond(201, { ...GOOD, extra: 1 }));
    expect((await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).ok).toBe(true);
  });

  it('maps a 409 to http with the error code', async () => {
    const { http } = fakeHttp(respond(409, { error: 'nickname_taken' }));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).toEqual({
      ok: false,
      error: { kind: 'http', status: 409, code: 'nickname_taken', retryAfterMs: null },
    });
  });

  it('keeps retry-after on a 503 and ignores a malformed code', async () => {
    const { http } = fakeHttp(respond(503, { error: 'Bad Code!' }, 20_000));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).toEqual({
      ok: false,
      error: { kind: 'http', status: 503, code: null, retryAfterMs: 20_000 },
    });
  });

  it('passes transport errors through', async () => {
    const { http } = fakeHttp({ ok: false, error: { kind: 'timeout' } });
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).create('Alice_1')).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });
});

describe('createSessionApi.renew', () => {
  const cred = { jid: JID, xmppPassword: PASSWORD, nickname: 'Alice_1' };
  const GOOD_RENEW = { nickname: 'Alice_1', token: 'ddd.eee.fff', token_type: 'Bearer', expires_in: 3600 };

  it('maps a 200 to nickname, token and expiry', async () => {
    const { http } = fakeHttp(respond(200, GOOD_RENEW));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).renew(cred)).toEqual({
      ok: true,
      value: { nickname: 'Alice_1', token: 'ddd.eee.fff', expiresIn: 3600 },
    });
  });

  it('sends exactly the jid and password, with a 15 s timeout and the signal', async () => {
    const { http, calls } = fakeHttp(respond(200, GOOD_RENEW));
    const ctrl = new AbortController();
    await createSessionApi(http, { xmppDomain: DOMAIN }).renew(cred, ctrl.signal);
    expect(calls[0]?.path).toBe('/session/renew');
    expect(calls[0]?.body).toEqual({ jid: JID, xmpp_password: PASSWORD });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['jid', 'xmpp_password']);
    expect(calls[0]?.opts.timeoutMs).toBe(15_000);
    expect(calls[0]?.opts.signal).toBe(ctrl.signal);
  });

  it('maps a 401 to http with invalid_credentials', async () => {
    const { http } = fakeHttp(respond(401, { error: 'invalid_credentials' }));
    expect(await createSessionApi(http, { xmppDomain: DOMAIN }).renew(cred)).toEqual({
      ok: false,
      error: { kind: 'http', status: 401, code: 'invalid_credentials', retryAfterMs: null },
    });
  });

  it('rejects a 201, a bad token_type and a bad nickname', async () => {
    const api = (b: HttpResponse['body'], status = 200): Promise<ApiResult<unknown>> =>
      createSessionApi(fakeHttp(respond(status, b)).http, { xmppDomain: DOMAIN }).renew(cred);
    const bad = { ok: false, error: { kind: 'bad-response' } };
    expect(await api(GOOD_RENEW, 201)).toEqual(bad);
    expect(await api({ ...GOOD_RENEW, token_type: 'Basic' })).toEqual(bad);
    expect(await api({ ...GOOD_RENEW, nickname: 'x' })).toEqual(bad);
    expect(await api({ ...GOOD_RENEW, expires_in: 59 })).toEqual(bad);
  });

  it('is built on the injected http only', () => {
    const postJson = vi.fn();
    createSessionApi({ postJson }, { xmppDomain: DOMAIN });
    expect(postJson).not.toHaveBeenCalled();
  });
});
