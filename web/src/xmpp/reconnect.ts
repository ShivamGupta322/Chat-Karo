export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction in [0,1): the delay is scaled by 1 +/- jitter. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0.2 };

/**
 * failures = 0 for the first retry. base = min(maxDelayMs, baseDelayMs * 2 ** failures).
 * The cap applies before jitter (24-36 s at the cap). 2 ** large is Infinity, which Math.min caps.
 */
export function backoffDelay(failures: number, policy: BackoffPolicy, random: () => number): number {
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** failures);
  return Math.round(base * (1 - policy.jitter + 2 * policy.jitter * random()));
}

export interface RetryScheduler {
  /** Schedules onFire after backoffDelay(failures); increments failures; returns { attempt: failures, at } (1-based). Cancels any pending timer. */
  schedule(onFire: () => void): { attempt: number; at: number };
  /** If a timer is pending: cancel it, invoke onFire synchronously, return true. Else false.
   *  Refunds the pending increment (failures - 1), so if this early attempt fails the next schedule()
   *  reuses the same delay and attempt number: wake-ups must not squeeze the backoff. */
  fireNow(): boolean;
  /** Cancels the pending timer only. */
  cancel(): void;
  /** failures = 0. */
  reset(): void;
  readonly pending: boolean;
}

export function createRetryScheduler(deps: {
  policy: BackoffPolicy;
  random: () => number;
  now: () => number;
}): RetryScheduler {
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let callback: (() => void) | null = null;

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    callback = null;
  }

  return {
    schedule(onFire) {
      clear();
      const delay = backoffDelay(failures, deps.policy, deps.random);
      failures += 1;
      callback = onFire;
      timer = setTimeout(() => {
        const cb = callback;
        timer = null;
        callback = null;
        cb?.();
      }, delay);
      return { attempt: failures, at: deps.now() + delay };
    },
    fireNow() {
      if (timer === null || callback === null) return false;
      const cb = callback;
      clear();
      failures = Math.max(0, failures - 1);
      cb();
      return true;
    },
    cancel: clear,
    reset() {
      failures = 0;
    },
    get pending() {
      return timer !== null;
    },
  };
}
