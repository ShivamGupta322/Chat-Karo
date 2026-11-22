// POST /api/locate (ADR-018, ADR-019 D3). The body is the centre of the caller's precision-7 cell, built from
// exactly two fields. Never throws, never logs: every outcome is a value.
import { isRecord, statusError, type ApiError, type ApiResult, type Http } from './http';
import type { TokenAccess } from './tokenManager';

export const LOCATE_TIMEOUT_MS = 10_000;

export interface LocatePoint {
  readonly lat: number;
  readonly lng: number;
}
export type LocateRange = 'block' | 'neighbourhood' | 'area';
export interface LocateAnswer {
  cell: string;
  precision: 5 | 6 | 7;
  range: LocateRange;
  roomJid: string;
}
export type LocateFailure =
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'offline' }
  | { kind: 'identity-invalid' }
  | { kind: 'bad-response' }
  | { kind: 'aborted' };
export type LocateResult = { ok: true; value: LocateAnswer } | { ok: false; error: LocateFailure };
export interface LocateApi {
  /** Never rejects. */
  locate: (point: LocatePoint, signal: AbortSignal) => Promise<LocateResult>;
}

const CELL_RE = /^[0-9b-hjkmnp-z]{5,7}$/;
const RANGE_PRECISION: Record<LocateRange, 5 | 6 | 7> = { block: 7, neighbourhood: 6, area: 5 };
const UNAVAILABLE_STATUSES = new Set([500, 502, 503, 504]);
const BAD: LocateFailure = { kind: 'bad-response' };

function isRange(v: unknown): v is LocateRange {
  return v === 'block' || v === 'neighbourhood' || v === 'area';
}

function failureFor(e: ApiError): LocateFailure {
  switch (e.kind) {
    case 'network':
    case 'timeout':
      return { kind: 'unavailable', retryAfterMs: null };
    case 'aborted':
      return { kind: 'aborted' };
    case 'bad-response':
      return BAD;
    case 'http':
      return UNAVAILABLE_STATUSES.has(e.status)
        ? { kind: 'unavailable', retryAfterMs: e.retryAfterMs }
        : BAD;
  }
}

function validate(body: unknown, mucDomain: string): LocateAnswer | null {
  if (!isRecord(body)) return null;
  const { cell, precision, range, room_jid: roomJid } = body;
  if (typeof cell !== 'string' || !CELL_RE.test(cell)) return null;
  if (precision !== 5 && precision !== 6 && precision !== 7) return null;
  if (cell.length !== precision) return null;
  if (!isRange(range) || RANGE_PRECISION[range] !== precision) return null;
  if (roomJid !== `g${String(precision)}_${cell}@${mucDomain}`) return null;
  return { cell, precision, range, roomJid };
}

export function createLocateApi(o: {
  http: Http;
  tokens: TokenAccess;
  mucDomain: string;
}): LocateApi {
  return {
    async locate(point, signal) {
      try {
        const call = async (token: string): Promise<ApiResult<unknown>> => {
          // Built from the two fields on purpose: never spread the input (no accuracy, no range).
          const r = await o.http.postJson(
            '/locate',
            { lat: point.lat, lng: point.lng },
            { timeoutMs: LOCATE_TIMEOUT_MS, token, signal },
          );
          if (!r.ok) return r;
          const failure = statusError(r.value, 200);
          if (failure !== null) return { ok: false, error: failure };
          return { ok: true, value: r.value.body };
        };
        const r = await o.tokens.withToken(call);
        if (r.ok) {
          const answer = validate(r.value, o.mucDomain);
          return answer === null ? { ok: false, error: BAD } : { ok: true, value: answer };
        }
        const e = r.error;
        if (e.kind === 'token') {
          if (e.reason === 'offline') return { ok: false, error: { kind: 'offline' } };
          if (e.reason === 'identity-invalid') return { ok: false, error: { kind: 'identity-invalid' } };
          return { ok: false, error: { kind: 'unavailable', retryAfterMs: null } };
        }
        // A second 401 after one renew and one retry: retrying the same way cannot help.
        if (e.kind === 'unauthorized') return { ok: false, error: BAD };
        return { ok: false, error: failureFor(e) };
      } catch {
        return { ok: false, error: BAD };
      }
    },
  };
}
