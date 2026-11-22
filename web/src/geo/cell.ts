import { decodeGeohashBounds, encodeGeohash, type GeohashError } from './geohash';

/** Precision 7 = "Block" (~150 m cells), ADR-001. */
export type CellPrecision = 7;

/** The only location-derived value allowed outside geo/. It carries no coordinates. */
export interface Cell {
  readonly precision: CellPrecision;
  readonly geohash: string;
}

export type CellResult = { ok: true; cell: Cell } | { ok: false; error: GeohashError };

export function cellFor(lat: number, lng: number, precision: CellPrecision): CellResult {
  const res = encodeGeohash(lat, lng, precision);
  if (!res.ok) return res;
  return { ok: true, cell: { precision, geohash: res.geohash } };
}

/** A raw point. It is turned into a Cell (or a request body) at once and never kept. */
export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export type CellCentreResult = { ok: true; point: GeoPoint } | { ok: false; error: 'invalid-geohash' };

/** The midpoint of the cell: the only location that ever leaves geo/ (via api/locate.ts, ADR-019 D3). */
export function cellCentre(cell: Cell): CellCentreResult {
  const res = decodeGeohashBounds(cell.geohash);
  if (!res.ok) return res;
  const { south, north, west, east } = res.bounds;
  return { ok: true, point: { lat: (south + north) / 2, lng: (west + east) / 2 } };
}
