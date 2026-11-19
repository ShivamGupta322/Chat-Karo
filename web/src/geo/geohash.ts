export type GeohashError = 'invalid-precision' | 'lat-out-of-range' | 'lng-out-of-range';
export type GeohashResult = { ok: true; geohash: string } | { ok: false; error: GeohashError };

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const MAX_PRECISION = 12;

/** True for finite numbers with lat in [-90, 90] and lng in [-180, 180]. */
export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Standard geohash. Bits interleave longitude first; a value at or above the midpoint takes the
 * upper half (so lat 90 / lng 180 land in the last cell). precision: integer 1..12.
 * Never throws; bad input returns a specific error.
 */
export function encodeGeohash(lat: number, lng: number, precision: number): GeohashResult {
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_PRECISION) {
    return { ok: false, error: 'invalid-precision' };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: 'lat-out-of-range' };
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, error: 'lng-out-of-range' };
  }
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let evenBit = true;
  let bits = 0;
  let index = 0;
  let out = '';
  while (out.length < precision) {
    if (evenBit) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        index = index * 2 + 1;
        lngLo = mid;
      } else {
        index *= 2;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        index = index * 2 + 1;
        latLo = mid;
      } else {
        index *= 2;
        latHi = mid;
      }
    }
    evenBit = !evenBit;
    bits += 1;
    if (bits === 5) {
      out += BASE32.charAt(index);
      bits = 0;
      index = 0;
    }
  }
  return { ok: true, geohash: out };
}
