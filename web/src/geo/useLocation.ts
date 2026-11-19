import { useCallback, useEffect, useReducer, useRef } from 'react';
import { cellFor, type Cell, type CellPrecision } from './cell';

export type LocationState =
  | { status: 'unsupported' }
  | { status: 'insecure-context' }
  | { status: 'checking' }
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'watching'; cell: Cell }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'timeout' };

export interface GeolocationLike {
  watchPosition(
    ok: PositionCallback,
    err: PositionErrorCallback,
    opts: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

export interface PermissionsLike {
  query(d: { name: 'geolocation' }): Promise<PermissionStatus>;
}

export interface LocationDeps {
  geolocation: GeolocationLike | null;
  permissions: PermissionsLike | null;
  isSecureContext: boolean | undefined;
}

/** Low accuracy is enough for a ~150 m cell and spares the battery. */
export const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 20_000,
  maximumAge: 60_000,
};

type PermissionValue = 'granted' | 'denied' | 'prompt';

/** Events carry a Cell or a small code, never a position or an error object. */
export type LocationEvent =
  | { type: 'start' }
  | { type: 'fix'; cell: Cell }
  | { type: 'error'; code: 1 | 2 | 3 }
  | { type: 'permission'; value: PermissionValue };

export function initialLocation(deps: LocationDeps): LocationState {
  if (deps.geolocation === null) return { status: 'unsupported' };
  if (deps.isSecureContext === false) return { status: 'insecure-context' };
  return deps.permissions === null ? { status: 'idle' } : { status: 'checking' };
}

export function reduceLocation(state: LocationState, event: LocationEvent): LocationState {
  switch (event.type) {
    case 'start':
      return state.status === 'requesting' ? state : { status: 'requesting' };
    case 'fix':
      if (state.status === 'watching' && state.cell.geohash === event.cell.geohash) return state;
      return { status: 'watching', cell: event.cell };
    case 'error':
      if (state.status === 'watching') {
        // After a fix, only a revoked permission matters; transient errors keep the last cell.
        return event.code === 1 ? { status: 'denied' } : state;
      }
      if (event.code === 1) return { status: 'denied' };
      return event.code === 2 ? { status: 'unavailable' } : { status: 'timeout' };
    case 'permission':
      if (event.value === 'denied') return { status: 'denied' };
      if (event.value === 'prompt' && (state.status === 'denied' || state.status === 'checking')) {
        return { status: 'idle' };
      }
      return state;
  }
}

function readGlobalDeps(): LocationDeps {
  const hasNavigator = typeof navigator !== 'undefined';
  return {
    geolocation: hasNavigator && 'geolocation' in navigator ? navigator.geolocation : null,
    permissions: hasNavigator && 'permissions' in navigator ? navigator.permissions : null,
    isSecureContext: typeof window === 'undefined' ? undefined : window.isSecureContext,
  };
}

function toCode(code: number): 1 | 2 | 3 {
  return code === 1 ? 1 : code === 3 ? 3 : 2;
}

/**
 * Watches the device position and exposes ONLY the cell it falls in. Coordinates exist as locals inside the
 * success callback and are converted immediately; nothing here logs, stores or keeps a position or an error.
 */
export function useLocation(
  precision: CellPrecision,
  deps?: LocationDeps,
): { state: LocationState; start: () => void } {
  const depsRef = useRef(deps);
  const [state, dispatch] = useReducer(
    reduceLocation,
    undefined,
    (): LocationState => initialLocation(deps ?? readGlobalDeps()),
  );
  const stateRef = useRef(state);
  const startRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  });

  useEffect(() => {
    const d = depsRef.current ?? readGlobalDeps();
    const geo = d.geolocation;
    if (geo === null || d.isSecureContext === false) return;
    let cancelled = false;
    let watchId: number | null = null;
    let hasFix = false;
    let permission: PermissionStatus | null = null;

    const clear = (): void => {
      if (watchId !== null) {
        geo.clearWatch(watchId);
        watchId = null;
      }
    };
    const fail = (code: 1 | 2 | 3): void => {
      if (!hasFix || code === 1) clear();
      dispatch({ type: 'error', code });
    };
    const begin = (): void => {
      clear();
      hasFix = false;
      dispatch({ type: 'start' });
      watchId = geo.watchPosition(
        (pos) => {
          if (cancelled) return;
          const res = cellFor(pos.coords.latitude, pos.coords.longitude, precision);
          if (!res.ok) {
            fail(2);
            return;
          }
          hasFix = true;
          dispatch({ type: 'fix', cell: res.cell });
        },
        (err) => {
          if (cancelled) return;
          fail(toCode(err.code));
        },
        WATCH_OPTIONS,
      );
    };
    const onPermissionChange = (): void => {
      if (cancelled || permission === null) return;
      const value = permission.state;
      if (value === 'granted') {
        const s = stateRef.current.status;
        if (s === 'idle' || s === 'denied') begin();
      } else if (value === 'denied') {
        clear();
        hasFix = false;
        dispatch({ type: 'permission', value });
      } else {
        dispatch({ type: 'permission', value });
      }
    };

    startRef.current = begin;

    if (d.permissions !== null) {
      d.permissions.query({ name: 'geolocation' }).then(
        (status) => {
          if (cancelled) return;
          permission = status;
          status.addEventListener('change', onPermissionChange);
          if (status.state === 'granted') begin();
          else dispatch({ type: 'permission', value: status.state });
        },
        () => {
          if (!cancelled) dispatch({ type: 'permission', value: 'prompt' });
        },
      );
    }

    return () => {
      cancelled = true;
      clear();
      permission?.removeEventListener('change', onPermissionChange);
      startRef.current = () => undefined;
    };
  }, [precision]);

  const start = useCallback(() => {
    startRef.current();
  }, []);

  return { state, start };
}
