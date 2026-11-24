// Asks geo_service which room belongs to a cell (ADR-019 D3). Framework-free: built once in main.tsx.
// The cell centre exists only as a local inside begin(); the state holds a Cell and the assigned room.
import { browserOnline, type OnlineSource, type Timers } from '../api';
import type { LocateApi } from '../api/locate';
import { cellCentre, type Cell } from './cell';

export type AssignFailure = 'unavailable' | 'offline' | 'identity-invalid' | 'bad-response';
export interface AssignedRoom {
  readonly jid: string;
  /** The room's own cell (geohash), for the label. */
  readonly cell: string;
}
export type RoomAssignment =
  | { status: 'none'; room: null }
  /** room = the previous room, kept until the new assignment arrives. */
  | { status: 'assigning'; cell: Cell; room: AssignedRoom | null }
  | { status: 'assigned'; cell: Cell; room: AssignedRoom }
  | { status: 'failed'; cell: Cell; reason: AssignFailure; room: null };

/** How a refresh() ended: 'superseded' = assign(), dispose(), retry() or another refresh() replaced it. */
export type RefreshOutcome = 'assigned' | 'failed' | 'superseded';

export interface RoomAssigner {
  /** The same geohash as the current target is a no-op. */
  assign: (cell: Cell | null) => void;
  /** Immediate; only does something in 'failed'. */
  retry: () => void;
  /**
   * Locates again for the current target and keeps the previous room meanwhile (ADR-020: a join was
   * refused because the server forgot our membership). Resolves when that request ends.
   */
  refresh: () => Promise<RefreshOutcome>;
  /** The same object until something changes (useSyncExternalStore). */
  getState: () => RoomAssignment;
  subscribe: (l: () => void) => () => void;
  dispose: () => void;
}

const defaultTimers: Timers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (h) => {
    globalThis.clearTimeout(h);
  },
};

const NONE: RoomAssignment = { status: 'none', room: null };

export function createRoomAssigner(o: {
  locate: LocateApi;
  timers?: Timers;
  online?: OnlineSource;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}): RoomAssigner {
  const timers = o.timers ?? defaultTimers;
  const online = o.online ?? browserOnline;
  const backoffBaseMs = o.backoffBaseMs ?? 5_000;
  const backoffMaxMs = o.backoffMaxMs ?? 30_000;

  let state: RoomAssignment = NONE;
  let target: Cell | null = null;
  let generation = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<Timers['set']> | null = null;
  let attempt = 0;
  let disposed = false;
  /** Settles the refresh() promise of the request in flight, if any. */
  let pendingRefresh: ((outcome: RefreshOutcome) => void) | null = null;
  const listeners = new Set<() => void>();

  function setState(next: RoomAssignment): void {
    state = next;
    for (const l of [...listeners]) l();
  }

  function clearTimer(): void {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function settleRefresh(outcome: RefreshOutcome): void {
    const settle = pendingRefresh;
    pendingRefresh = null;
    settle?.(outcome);
  }

  /** Every replacement of the request in flight goes through here, so a refresh() never hangs. */
  function cancelRequest(): void {
    settleRefresh('superseded');
    ctrl?.abort();
    ctrl = null;
    generation += 1;
  }

  function fail(cell: Cell, reason: AssignFailure): void {
    setState({ status: 'failed', cell, reason, room: null });
    settleRefresh('failed');
  }

  /** Starts one request for `cell`, keeping `kept` while it runs. Offline: no request. */
  function begin(
    cell: Cell,
    kept: AssignedRoom | null,
    onSettled: ((outcome: RefreshOutcome) => void) | null = null,
  ): void {
    pendingRefresh = onSettled;
    if (!online.isOnline()) {
      fail(cell, 'offline');
      return;
    }
    const centre = cellCentre(cell);
    if (!centre.ok) {
      fail(cell, 'bad-response');
      return;
    }
    const mine = generation;
    const controller = new AbortController();
    ctrl = controller;
    setState({ status: 'assigning', cell, room: kept });
    void (async (): Promise<void> => {
      const r = await o.locate.locate(centre.point, controller.signal);
      if (disposed || mine !== generation) return;
      ctrl = null;
      if (r.ok) {
        const v = r.value;
        if (v.range !== 'block' || v.precision !== 7 || v.cell !== cell.geohash) {
          fail(cell, 'bad-response');
          return;
        }
        attempt = 0;
        setState({ status: 'assigned', cell, room: { jid: v.roomJid, cell: v.cell } });
        settleRefresh('assigned');
        return;
      }
      const e = r.error;
      switch (e.kind) {
        case 'aborted':
          // Only our own abort ends a request this way, and that bumps the generation; be safe anyway.
          fail(cell, 'unavailable');
          return;
        case 'offline':
          fail(cell, 'offline');
          return;
        case 'identity-invalid':
          fail(cell, 'identity-invalid');
          return;
        case 'bad-response':
          fail(cell, 'bad-response');
          return;
        case 'unavailable': {
          if (!online.isOnline()) {
            fail(cell, 'offline');
            return;
          }
          const delay = Math.max(
            e.retryAfterMs ?? 0,
            Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs),
          );
          attempt += 1;
          fail(cell, 'unavailable');
          clearTimer();
          timer = timers.set(() => {
            timer = null;
            if (!disposed && mine === generation) begin(cell, null);
          }, delay);
        }
      }
    })();
  }

  function retry(): void {
    if (disposed || state.status !== 'failed') return;
    clearTimer();
    cancelRequest();
    begin(state.cell, null);
  }

  function refresh(): Promise<RefreshOutcome> {
    if (disposed || target === null) return Promise.resolve('superseded');
    const cell = target;
    clearTimer();
    cancelRequest();
    return new Promise<RefreshOutcome>((resolve) => {
      begin(cell, state.room, resolve);
    });
  }

  const offlineUnsub = online.subscribe(() => {
    if (state.status === 'failed' && (state.reason === 'offline' || state.reason === 'unavailable')) {
      retry();
    }
  });

  return {
    assign(cell) {
      if (disposed) return;
      if (cell === null) {
        clearTimer();
        cancelRequest();
        attempt = 0;
        target = null;
        if (state !== NONE) setState(NONE);
        return;
      }
      if (target !== null && target.geohash === cell.geohash) return;
      clearTimer();
      cancelRequest();
      attempt = 0;
      target = cell;
      begin(cell, state.room);
    },
    retry,
    refresh,
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    dispose() {
      disposed = true;
      clearTimer();
      cancelRequest();
      offlineUnsub();
      listeners.clear();
    },
  };
}
