import type { GeolocationLike, PermissionsLike } from '../../src/geo/useLocation';

export interface FakeGeolocation extends GeolocationLike {
  /** Number of watches that have been started and not cleared. */
  activeWatches(): number;
  /** Total watchPosition calls so far. */
  watchCalls(): number;
  /** Total clearWatch calls so far. */
  clearCalls(): number;
  /** Delivers a fix to every active watch. */
  emit(lat: number, lng: number): void;
  /** Delivers a PositionError code (1 denied, 2 unavailable, 3 timeout) to every active watch. */
  fail(code: 1 | 2 | 3): void;
}

export function createFakeGeolocation(): FakeGeolocation {
  let nextId = 1;
  let watches = 0;
  let clears = 0;
  const active = new Map<number, { ok: PositionCallback; err: PositionErrorCallback }>();
  return {
    watchPosition(ok, err) {
      const id = nextId++;
      watches += 1;
      active.set(id, { ok, err });
      return id;
    },
    clearWatch(id) {
      clears += 1;
      active.delete(id);
    },
    activeWatches: () => active.size,
    watchCalls: () => watches,
    clearCalls: () => clears,
    emit(lat, lng) {
      const pos = { coords: { latitude: lat, longitude: lng } } as unknown as GeolocationPosition;
      for (const w of [...active.values()]) w.ok(pos);
    },
    fail(code) {
      const e = { code, message: 'secret detail' } as unknown as GeolocationPositionError;
      for (const w of [...active.values()]) w.err(e);
    },
  };
}

export interface FakePermissions extends PermissionsLike {
  /** Sets the state and fires 'change' on every registered listener. */
  setState(state: PermissionState): void;
  listenerCount(): number;
  queries(): number;
}

/** A Permissions API double. initial = 'reject' makes query() reject. */
export function createFakePermissions(initial: PermissionState | 'reject'): FakePermissions {
  let state: PermissionState = initial === 'reject' ? 'prompt' : initial;
  let queryCount = 0;
  const listeners = new Set<EventListener>();
  const status = {
    get state() {
      return state;
    },
    addEventListener(_type: string, l: EventListener) {
      listeners.add(l);
    },
    removeEventListener(_type: string, l: EventListener) {
      listeners.delete(l);
    },
  } as unknown as PermissionStatus;
  return {
    query() {
      queryCount += 1;
      return initial === 'reject' ? Promise.reject(new Error('nope')) : Promise.resolve(status);
    },
    setState(next) {
      state = next;
      for (const l of [...listeners]) l(new Event('change'));
    },
    listenerCount: () => listeners.size,
    queries: () => queryCount,
  };
}

const saved: { name: string; target: object; desc: PropertyDescriptor | undefined }[] = [];

function override(target: object, name: string, value: unknown): void {
  saved.push({ name, target, desc: Object.getOwnPropertyDescriptor(target, name) });
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
}

/** Replaces navigator.geolocation / navigator.permissions / window.isSecureContext; call uninstallGeo in afterEach. */
export function installGeo(opts: {
  geolocation: GeolocationLike | null;
  permissions?: PermissionsLike | null;
  secure?: boolean | undefined;
}): void {
  override(navigator, 'geolocation', opts.geolocation ?? undefined);
  override(navigator, 'permissions', opts.permissions ?? undefined);
  override(window, 'isSecureContext', opts.secure);
  if (opts.geolocation === null) Reflect.deleteProperty(navigator, 'geolocation');
  if (!opts.permissions) Reflect.deleteProperty(navigator, 'permissions');
}

export function uninstallGeo(): void {
  while (saved.length > 0) {
    const s = saved.pop();
    if (!s) break;
    Reflect.deleteProperty(s.target, s.name);
    if (s.desc) Object.defineProperty(s.target, s.name, s.desc);
  }
}
