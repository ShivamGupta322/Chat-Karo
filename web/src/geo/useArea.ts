import { useCallback, useMemo, useState } from 'react';
import { cellFor, type Cell, type CellPrecision, type GeoPoint } from './cell';
import type { GeohashError } from './geohash';
import { useLocation, type LocationState } from './useLocation';

export interface DevOverride {
  readonly active: boolean;
  /** The dev cell (no coordinates), or null. */
  readonly cell: Cell | null;
  /** Validates via cellFor and stores ONLY the resulting Cell. The point is not retained. */
  set(point: GeoPoint): { ok: true } | { ok: false; error: GeohashError };
  clear(): void;
}

export type AreaState =
  | { status: 'located'; cell: Cell; source: 'device' | 'dev-pin'; moved: boolean }
  | { status: Exclude<LocationState['status'], 'watching'> };

export interface AreaController {
  state: AreaState;
  /** "Share my location" / "Try location again" */
  start: () => void;
  /** "Switch to my new area" */
  commitMove: () => void;
  dev: DevOverride;
}

const PRECISION: CellPrecision = 7;

/**
 * Combines the device location, an optional dev spot and the cell the user has settled in.
 * The room only changes on the first fix, a dev spot in another cell, commitMove, dev.clear and location loss;
 * later device fixes only raise `moved`. Nothing here holds a coordinate.
 */
export function useArea(): AreaController {
  const loc = useLocation(PRECISION);
  const [devCell, setDevCell] = useState<Cell | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);

  const latest = loc.state.status === 'watching' ? loc.state.cell.geohash : null;
  // Settle on the first fix and forget it when the device stops reporting (adjusted during render, no extra pass).
  let settled = committed;
  if (latest === null) settled = null;
  else if (settled === null) settled = latest;
  if (settled !== committed) setCommitted(settled);

  const commitMove = useCallback(() => {
    if (latest !== null) setCommitted(latest);
  }, [latest]);

  const setDev = useCallback((point: GeoPoint): { ok: true } | { ok: false; error: GeohashError } => {
    const res = cellFor(point.lat, point.lng, PRECISION);
    if (!res.ok) return { ok: false, error: res.error };
    setDevCell((prev) => (prev !== null && prev.geohash === res.cell.geohash ? prev : res.cell));
    return { ok: true };
  }, []);

  const clearDev = useCallback(() => {
    setDevCell(null);
    if (latest !== null) setCommitted(latest);
  }, [latest]);

  const dev = useMemo<DevOverride>(
    () => ({ active: devCell !== null, cell: devCell, set: setDev, clear: clearDev }),
    [devCell, setDev, clearDev],
  );

  const devGeohash = devCell === null ? null : devCell.geohash;
  const moved = devGeohash === null && settled !== null && latest !== settled;
  const passStatus = loc.state.status === 'watching' ? null : loc.state.status;
  const shownGeohash = devGeohash ?? settled;
  const source = devGeohash === null ? 'device' : 'dev-pin';

  const state = useMemo<AreaState>(() => {
    if (shownGeohash !== null) {
      return {
        status: 'located',
        cell: { precision: PRECISION, geohash: shownGeohash },
        source,
        moved,
      };
    }
    // shownGeohash is null only while the device is not watching, so passStatus is set.
    return { status: passStatus ?? 'unavailable' };
  }, [shownGeohash, source, moved, passStatus]);

  const start = loc.start;
  return useMemo(() => ({ state, start, commitMove, dev }), [state, start, commitMove, dev]);
}
