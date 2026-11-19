// Dev-only strings live in geo/ with the picker that uses them: they name raw coordinates, and keeping
// them here lets them tree-shake out of production builds.
export const DEV_LOCATION_TEXT = {
  summary: 'Test locations (dev)',
  presetA: 'Test spot A',
  presetB: 'Test spot B (next to A)',
  presetC: 'Test spot C (far away)',
  latitude: 'Latitude',
  longitude: 'Longitude',
  use: 'Use this spot',
  invalid: 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.',
  useReal: 'Use my real location',
} as const;
