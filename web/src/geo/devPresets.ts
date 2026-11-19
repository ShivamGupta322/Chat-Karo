import type { GeoPoint } from './useArea';

/** Dev only. Public sample points: A and B are neighbouring cells, C is a different city. */
export const DEV_PRESETS: readonly { id: 'A' | 'B' | 'C'; point: GeoPoint }[] = [
  { id: 'A', point: { lat: 57.64911, lng: 10.40744 } },
  { id: 'B', point: { lat: 57.64911, lng: 10.4087 } },
  { id: 'C', point: { lat: 51.5074, lng: -0.1278 } },
];
