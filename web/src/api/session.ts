import type { DeviceCredential } from './deviceCredential';
import type { ApiError, ApiResult, Http, HttpResponse } from './http';
import { isValidNickname, isValidPassword, jidPattern } from './identityRules';

export const SESSION_TIMEOUT_MS = 15_000;
export const RENEW_TIMEOUT_MS = 15_000;
/** Used by /api/locate in slice 3e-3. */
export const LOCATE_TIMEOUT_MS = 10_000;

export interface CreatedSession {
  credential: DeviceCredential;
  token: string;
  expiresIn: number;
}
export interface RenewedSession {
  nickname: string;
  token: string;
  expiresIn: number;
}
export interface SessionApi {
  /** POST {apiUrl}/session {"nickname"}. */
  create: (nickname: string) => Promise<ApiResult<CreatedSession>>;
  /** POST {apiUrl}/session/renew {"jid","xmpp_password"}. */
  renew: (c: DeviceCredential, signal?: AbortSignal) => Promise<ApiResult<RenewedSession>>;
}

const BAD: ApiError = { kind: 'bad-response' };
const TOKEN_RE = /^[A-Za-z0-9._-]{1,4096}$/;
const CODE_RE = /^[a-z_]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** null when the response has the expected success status; otherwise the error to return. */
function statusError(res: HttpResponse, expected: number): ApiError | null {
  if (res.status === expected) return null;
  if (res.status >= 200 && res.status < 300) return BAD;
  const code =
    isRecord(res.body) && typeof res.body.error === 'string' && CODE_RE.test(res.body.error)
      ? res.body.error
      : null;
  return { kind: 'http', status: res.status, code, retryAfterMs: res.retryAfterMs };
}

function tokenFields(b: Record<string, unknown>): { token: string; expiresIn: number } | null {
  const { token, token_type: tokenType, expires_in: expiresIn } = b;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  if (tokenType !== 'Bearer') return null;
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn)) return null;
  if (expiresIn < 60 || expiresIn > 86_400) return null;
  return { token, expiresIn };
}

export function createSessionApi(http: Http, o: { xmppDomain: string }): SessionApi {
  const jidRe = jidPattern(o.xmppDomain);

  return {
    async create(nickname) {
      const r = await http.postJson('/session', { nickname }, { timeoutMs: SESSION_TIMEOUT_MS });
      if (!r.ok) return r;
      const failure = statusError(r.value, 201);
      if (failure !== null) return { ok: false, error: failure };
      const b = r.value.body;
      if (!isRecord(b)) return { ok: false, error: BAD };
      const t = tokenFields(b);
      if (
        t === null ||
        typeof b.jid !== 'string' ||
        !jidRe.test(b.jid) ||
        !isValidPassword(b.xmpp_password) ||
        !isValidNickname(b.nickname)
      ) {
        return { ok: false, error: BAD };
      }
      return {
        ok: true,
        value: {
          credential: { jid: b.jid, xmppPassword: b.xmpp_password, nickname: b.nickname },
          token: t.token,
          expiresIn: t.expiresIn,
        },
      };
    },

    async renew(c, signal) {
      const r = await http.postJson(
        '/session/renew',
        { jid: c.jid, xmpp_password: c.xmppPassword },
        signal === undefined ? { timeoutMs: RENEW_TIMEOUT_MS } : { timeoutMs: RENEW_TIMEOUT_MS, signal },
      );
      if (!r.ok) return r;
      const failure = statusError(r.value, 200);
      if (failure !== null) return { ok: false, error: failure };
      const b = r.value.body;
      if (!isRecord(b)) return { ok: false, error: BAD };
      const t = tokenFields(b);
      if (t === null || !isValidNickname(b.nickname)) return { ok: false, error: BAD };
      return { ok: true, value: { nickname: b.nickname, token: t.token, expiresIn: t.expiresIn } };
    },
  };
}
