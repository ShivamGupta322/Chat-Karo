import { describe, expect, it } from 'vitest';
import type { OnlineSource, Timers } from '../../src/api';
import type { LocateApi, LocatePoint, LocateResult } from '../../src/api/locate';
import { createRoomAssigner, type RoomAssignment } from '../../src/geo/roomAssigner';

const MUC = 'muc.chaterl.localhost';
const A = { precision: 7, geohash: 'u4pruyd' } as const;
const B = { precision: 7, geohash: 'u4pruye' } as const;
// Hard-coded oracle centres (never derived from cellCentre).
// The shortest round-trip form of the double; the lint rule wants 17 significant digits.
// eslint-disable-next-line no-loss-of-precision
const CENTRE_A = { lat: 57.64869689941406, lng: 10.407485961914062 };
const CENTRE_B = { lat: 57.64869689941406, lng: 10.408859252929688 };

const answer = (cell: string): LocateResult => ({
  ok: true,
  value: { cell, precision: 7, range: 'block', roomJid: `g7_${cell}@${MUC}` },
});
const failure = (error: Extract<LocateResult, { ok: false }>['error']): LocateResult => ({
  ok: false,
  error,
});

interface Req {
  point: LocatePoint;
  signal: AbortSignal;
  resolve(r: LocateResult): void;
}

function setup(): {
  assigner: ReturnType<typeof createRoomAssigner>;
  reqs: Req[];
  timers: { pending: { ms: number; fire(): void }[]; fired: number[]; fireNext(): void };
  net: { online: boolean; fire(): void };
  changes: number[];
} {
  const reqs: Req[] = [];
  const locate: LocateApi = {
    locate: (point, signal) =>
      new Promise<LocateResult>((resolve) => {
        reqs.push({ point, signal, resolve });
      }),
  };
  const pending: { ms: number; fire(): void; id: number }[] = [];
  let nextId = 1;
  const timers = {
    pending,
    fired: [] as number[],
    fireNext() {
      const t = pending.shift();
      if (t === undefined) throw new Error('no pending timer');
      timers.fired.push(t.ms);
      t.fire();
    },
  };
  const fake: Timers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.push({ ms, fire: fn, id });
      return id as unknown as ReturnType<Timers['set']>;
    },
    clear: (h) => {
      const i = pending.findIndex((p) => p.id === (h as unknown as number));
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const listeners = new Set<() => void>();
  const net = {
    online: true,
    fire() {
      for (const l of [...listeners]) l();
    },
  };
  const online: OnlineSource = {
    isOnline: () => net.online,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  const assigner = createRoomAssigner({ locate, timers: fake, online });
  const changes: number[] = [];
  assigner.subscribe(() => changes.push(1));
  return { assigner, reqs, timers, net, changes };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createRoomAssigner', () => {
  it('sends one request with exactly the centre, assigning (no room) then assigned', async () => {
    const { assigner, reqs } = setup();
    expect(assigner.getState()).toEqual({ status: 'none', room: null });
    assigner.assign(A);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.point).toEqual(CENTRE_A);
    expect(assigner.getState()).toEqual({ status: 'assigning', cell: A, room: null });
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    expect(assigner.getState()).toEqual({
      status: 'assigned',
      cell: A,
      room: { jid: `g7_u4pruyd@${MUC}`, cell: 'u4pruyd' },
    });
  });

  it.each(['assigning', 'assigned', 'failed'] as const)(
    'the same cell again while %s is a no-op',
    async (phase) => {
      const { assigner, reqs } = setup();
      assigner.assign(A);
      if (phase === 'assigned') {
        reqs[0]?.resolve(answer('u4pruyd'));
        await flush();
      } else if (phase === 'failed') {
        reqs[0]?.resolve(failure({ kind: 'bad-response' }));
        await flush();
      }
      expect(assigner.getState().status).toBe(phase);
      const before = assigner.getState();
      assigner.assign({ precision: 7, geohash: 'u4pruyd' });
      expect(reqs).toHaveLength(1);
      expect(assigner.getState()).toBe(before);
    },
  );

  it('a switch keeps the old room while assigning, then replaces it', async () => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    assigner.assign(B);
    expect(reqs[1]?.point).toEqual(CENTRE_B);
    expect(assigner.getState()).toEqual({
      status: 'assigning',
      cell: B,
      room: { jid: `g7_u4pruyd@${MUC}`, cell: 'u4pruyd' },
    });
    reqs[1]?.resolve(answer('u4pruye'));
    await flush();
    expect(assigner.getState()).toMatchObject({
      status: 'assigned',
      room: { jid: `g7_u4pruye@${MUC}` },
    });
  });

  it('a fast switch aborts the first request and ignores its late result', async () => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    assigner.assign(B);
    assigner.assign({ precision: 7, geohash: 'gcpvj0d' });
    expect(reqs[1]?.signal.aborted).toBe(true);
    expect(reqs[2]?.signal.aborted).toBe(false);
    reqs[1]?.resolve(answer('u4pruye'));
    await flush();
    expect(assigner.getState().status).toBe('assigning');
    reqs[2]?.resolve(answer('gcpvj0d'));
    await flush();
    expect(assigner.getState()).toMatchObject({ status: 'assigned', room: { cell: 'gcpvj0d' } });
  });

  it('A -> B (pending) -> A sends a new request and ends assigned A', async () => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    assigner.assign(B);
    assigner.assign(A);
    expect(reqs).toHaveLength(3);
    expect(reqs[1]?.signal.aborted).toBe(true);
    reqs[2]?.resolve(answer('u4pruyd'));
    await flush();
    expect(assigner.getState()).toMatchObject({ status: 'assigned', cell: A });
  });

  it('assign(null) aborts, goes to none and ignores a late result', async () => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    assigner.assign(null);
    expect(reqs[0]?.signal.aborted).toBe(true);
    expect(assigner.getState()).toEqual({ status: 'none', room: null });
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    expect(assigner.getState()).toEqual({ status: 'none', room: null });
  });

  it('assign(null) cancels a pending retry timer', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(timers.pending).toHaveLength(1);
    assigner.assign(null);
    expect(timers.pending).toHaveLength(0);
  });

  it.each([
    ['another cell', { cell: 'u4pruye', roomJid: `g7_u4pruye@${MUC}` }],
    ['precision 6', { precision: 6 as const }],
    ['range area', { range: 'area' as const }],
  ])('a local check rejects an answer with %s: failed, no room', async (_n, patch) => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    const ok = answer('u4pruyd');
    if (!ok.ok) throw new Error('unreachable');
    reqs[0]?.resolve({ ok: true, value: { ...ok.value, ...patch } });
    await flush();
    expect(assigner.getState()).toEqual({
      status: 'failed',
      cell: A,
      reason: 'bad-response',
      room: null,
    });
  });

  it('retries an unavailable at 5, 10, 20, 30, 30 s', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    for (let i = 0; i < 5; i++) {
      reqs[i]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
      await flush();
      expect(assigner.getState()).toMatchObject({ status: 'failed', reason: 'unavailable', room: null });
      timers.fireNext();
      expect(reqs).toHaveLength(i + 2);
      expect(assigner.getState()).toEqual({ status: 'assigning', cell: A, room: null });
    }
    expect(timers.fired).toEqual([5000, 10000, 20000, 30000, 30000]);
  });

  it('retryAfterMs 8000 beats the 5000 backoff', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: 8000 }));
    await flush();
    expect(timers.pending[0]?.ms).toBe(8000);
  });

  it('success resets the backoff', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    timers.fireNext();
    reqs[1]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    timers.fireNext();
    reqs[2]?.resolve(answer('u4pruyd'));
    await flush();
    assigner.assign(B);
    reqs[3]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(timers.pending[0]?.ms).toBe(5000);
  });

  it('a new cell resets the backoff', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    timers.fireNext();
    reqs[1]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    assigner.assign(B);
    expect(timers.pending).toHaveLength(0);
    reqs[2]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(timers.pending[0]?.ms).toBe(5000);
  });

  it('retry() is immediate and cancels the timer', async () => {
    const { assigner, reqs, timers } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(timers.pending).toHaveLength(1);
    assigner.retry();
    expect(timers.pending).toHaveLength(0);
    expect(reqs).toHaveLength(2);
    expect(assigner.getState().status).toBe('assigning');
  });

  it('retry() does nothing outside failed', () => {
    const { assigner, reqs } = setup();
    assigner.retry();
    assigner.assign(A);
    assigner.retry();
    expect(reqs).toHaveLength(1);
  });

  it.each(['identity-invalid', 'bad-response'] as const)(
    '%s never auto-retries, but retry() works',
    async (kind) => {
      const { assigner, reqs, timers } = setup();
      assigner.assign(A);
      reqs[0]?.resolve(failure({ kind }));
      await flush();
      expect(assigner.getState()).toEqual({ status: 'failed', cell: A, reason: kind, room: null });
      expect(timers.pending).toHaveLength(0);
      assigner.retry();
      expect(reqs).toHaveLength(2);
    },
  );

  it('offline: no request; the online event starts one', async () => {
    const { assigner, reqs, net } = setup();
    net.online = false;
    assigner.assign(A);
    expect(reqs).toHaveLength(0);
    expect(assigner.getState()).toEqual({ status: 'failed', cell: A, reason: 'offline', room: null });
    net.online = true;
    net.fire();
    expect(reqs).toHaveLength(1);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    expect(assigner.getState().status).toBe('assigned');
  });

  it('offline failure from locate -> failed offline, no timer; online retries', async () => {
    const { assigner, reqs, timers, net } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'offline' }));
    await flush();
    expect(assigner.getState()).toMatchObject({ status: 'failed', reason: 'offline' });
    expect(timers.pending).toHaveLength(0);
    net.fire();
    expect(reqs).toHaveLength(2);
  });

  it('unavailable while offline -> offline with no timer', async () => {
    const { assigner, reqs, timers, net } = setup();
    assigner.assign(A);
    net.online = false;
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(assigner.getState()).toMatchObject({ status: 'failed', reason: 'offline' });
    expect(timers.pending).toHaveLength(0);
  });

  it('the online event retries a failed unavailable at once and drops its timer', async () => {
    const { assigner, reqs, timers, net } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    net.fire();
    expect(reqs).toHaveLength(2);
    expect(timers.pending).toHaveLength(0);
  });

  it('the online event ignores identity-invalid and assigned states', async () => {
    const { assigner, reqs, net } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'identity-invalid' }));
    await flush();
    net.fire();
    expect(reqs).toHaveLength(1);
  });

  it('getState() keeps its reference across a no-op assign and changes on a real change', async () => {
    const { assigner, reqs, changes } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    const s = assigner.getState();
    const n = changes.length;
    assigner.assign(A);
    expect(assigner.getState()).toBe(s);
    expect(changes).toHaveLength(n);
    assigner.assign(B);
    expect(assigner.getState()).not.toBe(s);
  });

  it('dispose() stops the timer, the online subscription, the listeners and late results', async () => {
    const { assigner, reqs, timers, net, changes } = setup();
    assigner.assign(A);
    reqs[0]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    assigner.dispose();
    expect(timers.pending).toHaveLength(0);
    const n = changes.length;
    net.fire();
    assigner.assign(B);
    assigner.retry();
    expect(reqs).toHaveLength(1);
    expect(changes).toHaveLength(n);
  });

  it('dispose() aborts an in-flight request and ignores its result', async () => {
    const { assigner, reqs } = setup();
    assigner.assign(A);
    assigner.dispose();
    expect(reqs[0]?.signal.aborted).toBe(true);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    expect(assigner.getState().status).toBe('assigning');
  });

  it('never holds a coordinate in its state', async () => {
    const { assigner, reqs } = setup();
    const seen: RoomAssignment[] = [];
    assigner.subscribe(() => seen.push(assigner.getState()));
    assigner.assign(A);
    reqs[0]?.resolve(answer('u4pruyd'));
    await flush();
    assigner.assign(B);
    reqs[1]?.resolve(failure({ kind: 'unavailable', retryAfterMs: null }));
    await flush();
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) expect(JSON.stringify(s)).not.toMatch(/\d+\.\d{3,}|"(lat|lng)"/);
  });
});
