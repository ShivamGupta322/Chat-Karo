import { encodeGeohash, type GeohashError } from './geohash';

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

// TEMPORARY (Phase 3): client-side room assignment. Replaced by geo_service /api/locate; delete
// roomJidForCell and its single call site in pages/Chat.tsx when the client switches. (cellFor stays.)
/** 'g7_u4pruyd@muc.chaterl.localhost' */
export function roomJidForCell(cell: Cell, mucDomain: string): string {
  return `g${String(cell.precision)}_${cell.geohash}@${mucDomain}`;
}
