import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { Cell } from './cell';
import type { RefreshOutcome, RoomAssigner, RoomAssignment } from './roomAssigner';

const RoomAssignerContext = createContext<RoomAssigner | null>(null);

export function RoomAssignerProvider({
  assigner,
  children,
}: {
  assigner: RoomAssigner;
  children: ReactNode;
}): React.JSX.Element {
  return <RoomAssignerContext.Provider value={assigner}>{children}</RoomAssignerContext.Provider>;
}

/** Keeps the assigner pointed at `cell` (compared by geohash) and exposes its state. */
export function useRoomAssignment(cell: Cell | null): {
  assignment: RoomAssignment;
  retry: () => void;
  refresh: () => Promise<RefreshOutcome>;
} {
  const assigner = useContext(RoomAssignerContext);
  if (assigner === null) throw new Error('useRoomAssignment must be used inside a RoomAssignerProvider');
  const geohash = cell === null ? null : cell.geohash;

  useEffect(() => {
    assigner.assign(geohash === null ? null : { precision: 7, geohash });
  }, [assigner, geohash]);
  useEffect(
    () => () => {
      assigner.assign(null);
    },
    [assigner],
  );

  const assignment = useSyncExternalStore(assigner.subscribe, assigner.getState);
  return { assignment, retry: assigner.retry, refresh: assigner.refresh };
}
