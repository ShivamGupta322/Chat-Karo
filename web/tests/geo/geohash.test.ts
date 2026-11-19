import { describe, expect, it } from 'vitest';
import { encodeGeohash, isValidLatLng } from '../../src/geo/geohash';
import { VECTORS } from './vectors';

describe('encodeGeohash', () => {
  it.each(VECTORS)('(%f, %f) at precision 7 is %s', (lat, lng, expected) => {
    expect(encodeGeohash(lat, lng, 7)).toEqual({ ok: true, geohash: expected });
  });

  it('matches the known precision-12 value', () => {
    expect(encodeGeohash(57.64911, 10.40744, 12)).toEqual({ ok: true, geohash: 'u4pruydqqvj8' });
  });

  it.each(VECTORS)('precision 12 for (%f, %f) starts with the precision-7 cell %s', (lat, lng, seven) => {
    const twelve = encodeGeohash(lat, lng, 12);
    expect(twelve.ok && twelve.geohash.startsWith(seven)).toBe(true);
    expect(twelve.ok && twelve.geohash.length).toBe(12);
  });

  it('accepts the exact boundaries', () => {
    for (const [lat, lng] of [
      [90, 180],
      [-90, -180],
      [90, -180],
      [-90, 180],
    ] as const) {
      expect(encodeGeohash(lat, lng, 7).ok).toBe(true);
    }
  });

  it('puts points just across the antimeridian in different cells (standard geohash behaviour)', () => {
    const east = encodeGeohash(0, 179.9999, 7);
    const west = encodeGeohash(0, -179.9999, 7);
    expect(east).toEqual({ ok: true, geohash: 'xbpbpbp' });
    expect(west).toEqual({ ok: true, geohash: '8000000' });
  });

  it.each([
    ['lat above', 90.0001, 0, 'lat-out-of-range'],
    ['lat below', -90.0001, 0, 'lat-out-of-range'],
    ['lng above', 0, 180.0001, 'lng-out-of-range'],
    ['lng below', 0, -180.0001, 'lng-out-of-range'],
    ['lat NaN', Number.NaN, 0, 'lat-out-of-range'],
    ['lng NaN', 0, Number.NaN, 'lng-out-of-range'],
    ['lat Infinity', Number.POSITIVE_INFINITY, 0, 'lat-out-of-range'],
    ['lat -Infinity', Number.NEGATIVE_INFINITY, 0, 'lat-out-of-range'],
    ['lng Infinity', 0, Number.POSITIVE_INFINITY, 'lng-out-of-range'],
    ['lng -Infinity', 0, Number.NEGATIVE_INFINITY, 'lng-out-of-range'],
  ] as const)('rejects %s', (_name, lat, lng, error) => {
    expect(encodeGeohash(lat, lng, 7)).toEqual({ ok: false, error });
  });

  it.each([0, 13, 7.5, -1, Number.NaN])('rejects precision %s', (precision) => {
    expect(encodeGeohash(0, 0, precision)).toEqual({ ok: false, error: 'invalid-precision' });
  });

  it('reports a bad precision before bad coordinates and never throws', () => {
    expect(() => encodeGeohash(Number.NaN, Number.NaN, 0)).not.toThrow();
    expect(encodeGeohash(Number.NaN, Number.NaN, 0)).toEqual({
      ok: false,
      error: 'invalid-precision',
    });
  });
});

describe('isValidLatLng', () => {
  it('accepts in-range finite values, including the corners', () => {
    expect(isValidLatLng(0, 0)).toBe(true);
    expect(isValidLatLng(90, 180)).toBe(true);
    expect(isValidLatLng(-90, -180)).toBe(true);
  });
  it('rejects out-of-range and non-finite values', () => {
    expect(isValidLatLng(90.1, 0)).toBe(false);
    expect(isValidLatLng(0, -180.1)).toBe(false);
    expect(isValidLatLng(Number.NaN, 0)).toBe(false);
    expect(isValidLatLng(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
