import { describe, expect, it } from 'vitest';
import { cellCentre, cellFor } from '../../src/geo/cell';
import { VECTORS } from './vectors';

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

describe('cellCentre', () => {
  // Hard-coded oracle values (the same centre geo_service stores in rooms.center), never derived from cellCentre.
  it.each([
    // eslint-disable-next-line no-loss-of-precision
    ['u4pruyd', 57.64869689941406, 10.407485961914062],
    ['u4pruye', 57.64869689941406, 10.408859252929688],
    ['gcpvj0d', 51.50733947753906, -0.1284027099609375],
  ])('%s -> exactly (%f, %f)', (geohash, lat, lng) => {
    expect(cellCentre({ precision: 7, geohash })).toEqual({ ok: true, point: { lat, lng } });
  });

  it.each(VECTORS)('the centre of the cell of (%f, %f) is in the same cell', (lat, lng, expected) => {
    const centre = cellCentre({ precision: 7, geohash: expected });
    expect(centre.ok).toBe(true);
    if (centre.ok) {
      expect(cellFor(centre.point.lat, centre.point.lng, 7)).toEqual({
        ok: true,
        cell: { precision: 7, geohash: expected },
      });
    }
  });

  it('is not the raw point it was derived from', () => {
    const centre = cellCentre({ precision: 7, geohash: 'u4pruyd' });
    expect(centre.ok).toBe(true);
    if (centre.ok) {
      expect(centre.point.lat).not.toBe(57.64911);
      expect(centre.point.lng).not.toBe(10.40744);
    }
  });

  it('rejects an invalid geohash', () => {
    expect(cellCentre({ precision: 7, geohash: 'u4prA' })).toEqual({
      ok: false,
      error: 'invalid-geohash',
    });
  });
});
