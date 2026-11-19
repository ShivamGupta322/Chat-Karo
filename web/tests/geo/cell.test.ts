import { describe, expect, it } from 'vitest';
import { cellFor, roomJidForCell } from '../../src/geo/cell';
import { isValidRoomJid } from '../../src/xmpp';
import { VECTORS } from './vectors';

const MUC = 'muc.chaterl.localhost';

describe('cellFor', () => {
  it.each(VECTORS)('(%f, %f) -> %s', (lat, lng, expected) => {
    expect(cellFor(lat, lng, 7)).toEqual({ ok: true, cell: { precision: 7, geohash: expected } });
  });

  it('gives an equal Cell for the three points in one cell, and a different one for the neighbour', () => {
    const a = cellFor(57.64911, 10.40744, 7);
    const b = cellFor(57.6492, 10.4075, 7);
    const c = cellFor(57.6488, 10.4069, 7);
    const next = cellFor(57.64911, 10.4087, 7);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).not.toEqual(next);
  });

  it('passes the specific error through', () => {
    expect(cellFor(91, 0, 7)).toEqual({ ok: false, error: 'lat-out-of-range' });
    expect(cellFor(0, 181, 7)).toEqual({ ok: false, error: 'lng-out-of-range' });
  });
});

describe('roomJidForCell', () => {
  it('builds g7_<geohash>@<muc domain>', () => {
    expect(roomJidForCell({ precision: 7, geohash: 'u4pruyd' }, MUC)).toBe(
      'g7_u4pruyd@muc.chaterl.localhost',
    );
  });

  it.each(VECTORS)('is a valid room address for (%f, %f)', (lat, lng) => {
    const res = cellFor(lat, lng, 7);
    expect(res.ok).toBe(true);
    if (res.ok) expect(isValidRoomJid(roomJidForCell(res.cell, MUC), MUC)).toBe(true);
  });
});
