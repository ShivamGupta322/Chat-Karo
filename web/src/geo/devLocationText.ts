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

export const DEV_MAP_TEXT = {
  label: 'Test location map',
  hint: 'Click the map to move to that area. The shaded square is the whole area, not an exact spot. Keyboard users: use the test spots and fields above (arrow keys pan the map, plus and minus zoom).',
  loading: 'Loading map…',
  failed: "The map couldn't load. Use the test spots above.",
  noTiles: 'Set VITE_MAP_TILE_URL in .env to show a map here.',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
} as const;
