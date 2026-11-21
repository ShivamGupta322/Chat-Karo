// The only module that calls fetch. It never throws and never logs: every outcome is a value.
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
export interface Timers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(h: TimerHandle): void;
}
export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: RequestInit) => Promise<HttpResponseLike>;

export type ApiError =
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'bad-response' }
  | { kind: 'http'; status: number; code: string | null; retryAfterMs: number | null };
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface HttpResponse {
  status: number;
  body: unknown;
  retryAfterMs: number | null;
}
export interface PostOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  token?: string;
}
export interface Http {
  postJson(path: `/${string}`, body: unknown, opts: PostOptions): Promise<ApiResult<HttpResponse>>;
}

const MAX_BODY_CHARS = 65_536;
const MAX_RETRY_AFTER_MS = 300_000;

const defaultTimers: Timers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (h) => {
    globalThis.clearTimeout(h);
  },
};

// Resolved at call time so test fakes installed on globalThis apply.
const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

function parseRetryAfter(raw: string | null): number | null {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
  return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
}

interface Raw {
  status: number;
  text: string;
  retry: string | null;
}

export function createHttp(o: { baseUrl: string; fetch?: FetchLike; timers?: Timers }): Http {
  const doFetch = o.fetch ?? defaultFetch;
  const timers = o.timers ?? defaultTimers;

  return {
    async postJson(path, body, opts) {
      const externallyAborted = (): boolean => opts.signal?.aborted === true;
      if (externallyAborted()) return { ok: false, error: { kind: 'aborted' } };

      const ctrl = new AbortController();
      let timedOut = false;
      const onExternalAbort = (): void => {
        ctrl.abort();
      };
      opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
      const timer = timers.set(() => {
        timedOut = true;
        ctrl.abort();
      }, opts.timeoutMs);

      // Rejects when aborted, so a fetch that ignores its signal still ends at the deadline.
      const abortion = new Promise<never>((_resolve, reject) => {
        ctrl.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      abortion.catch(() => undefined);

      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
        const init: RequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: ctrl.signal,
        };
        const run = async (): Promise<Raw> => {
          const res = await doFetch(o.baseUrl + path, init);
          const text = await res.text();
          return { status: res.status, text, retry: res.headers.get('retry-after') };
        };
        const res = await Promise.race([run(), abortion]);
        const success = res.status >= 200 && res.status < 300;
        if (res.text.length > MAX_BODY_CHARS) return { ok: false, error: { kind: 'bad-response' } };
        let parsed: unknown = null;
        if (res.text.trim() !== '') {
          try {
            parsed = JSON.parse(res.text);
          } catch {
            if (success) return { ok: false, error: { kind: 'bad-response' } };
            parsed = null;
          }
        }
        return {
          ok: true,
          value: { status: res.status, body: parsed, retryAfterMs: parseRetryAfter(res.retry) },
        };
      } catch {
        if (timedOut) return { ok: false, error: { kind: 'timeout' } };
        if (externallyAborted()) return { ok: false, error: { kind: 'aborted' } };
        return { ok: false, error: { kind: 'network' } };
      } finally {
        timers.clear(timer);
        opts.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
