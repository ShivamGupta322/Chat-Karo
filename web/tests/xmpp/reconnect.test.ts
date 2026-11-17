import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKOFF, backoffDelay, createRetryScheduler } from '../../src/xmpp/reconnect';

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 30 s (random 0.5 = no jitter)', () => {
    const got = [0, 1, 2, 3, 4, 5, 6].map((f) => backoffDelay(f, DEFAULT_BACKOFF, () => 0.5));
    expect(got).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('applies +/-20% jitter around the base', () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(800);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999999)).toBeCloseTo(1200, -1);
  });

  it('applies the cap before jitter (24-36 s at the cap)', () => {
    expect(backoffDelay(9, DEFAULT_BACKOFF, () => 0)).toBe(24000);
    expect(backoffDelay(9, DEFAULT_BACKOFF, () => 0.999999)).toBeGreaterThan(35990);
    expect(backoffDelay(9, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThanOrEqual(36000);
  });

  it('stays finite for absurd failure counts', () => {
    const d = backoffDelay(1000, DEFAULT_BACKOFF, () => 0.999999);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeLessThanOrEqual(36000);
  });
});

describe('createRetryScheduler', () => {
  let clock = 0;
  const make = () =>
    createRetryScheduler({ policy: DEFAULT_BACKOFF, random: () => 0.5, now: () => clock });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 5_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('numbers attempts 1, 2, 3 and reports at = now + delay', () => {
    const s = make();
    expect(s.schedule(() => undefined)).toEqual({ attempt: 1, at: 6_000 });
    expect(s.schedule(() => undefined)).toEqual({ attempt: 2, at: 7_000 });
    expect(s.schedule(() => undefined)).toEqual({ attempt: 3, at: 9_000 });
  });

  it('fires only after the delay', () => {
    const s = make();
    const fn = vi.fn();
    s.schedule(fn);
    expect(s.pending).toBe(true);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(false);
  });

  it('a new schedule cancels the pending timer', () => {
    const s = make();
    const first = vi.fn();
    const second = vi.fn();
    s.schedule(first);
    s.schedule(second);
    vi.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fireNow fires synchronously, clears the timer and refunds the pending failure', () => {
    const s = make();
    const fn = vi.fn();
    s.schedule(fn);
    expect(s.fireNow()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.pending).toBe(false);
    // The early attempt did not consume a backoff step: the next schedule reuses attempt 1.
    expect(s.schedule(() => undefined).attempt).toBe(1);
  });

  it('fireNow with nothing pending returns false', () => {
    expect(make().fireNow()).toBe(false);
  });

  it('reset makes the next delay 1 s again', () => {
    const s = make();
    s.schedule(() => undefined);
    s.schedule(() => undefined);
    s.reset();
    expect(s.schedule(() => undefined)).toEqual({ attempt: 1, at: 6_000 });
  });

  it('cancel stops the callback', () => {
    const s = make();
    const fn = vi.fn();
    s.schedule(fn);
    s.cancel();
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    expect(s.pending).toBe(false);
  });
});
