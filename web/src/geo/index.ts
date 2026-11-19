// The only public entry of geo/. Raw coordinates stay inside this folder: other modules see a Cell, never a point.
export { useArea } from './useArea';
export type { AreaController, AreaState, DevOverride, GeoPoint } from './useArea';
export { DevLocationPicker } from './DevLocationPicker';
export { roomJidForCell } from './cell';
export type { Cell, CellPrecision } from './cell';
