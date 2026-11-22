// The only public entry of geo/. Raw coordinates stay inside this folder: other modules see a Cell, never a point.
// Coordinates leave geo/ only as a cell centre, through api/locate.ts.
export { useArea } from './useArea';
export type { AreaController, AreaState, DevOverride } from './useArea';
export { DevLocationPicker } from './DevLocationPicker';
export { RoomAssignerProvider, useRoomAssignment } from './RoomAssignment';
export { createRoomAssigner } from './roomAssigner';
export type { AssignFailure, AssignedRoom, RoomAssigner, RoomAssignment } from './roomAssigner';
export type { Cell, CellPrecision } from './cell';
