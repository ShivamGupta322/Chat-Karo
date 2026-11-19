import { useCallback, useEffect } from 'react';
import type { XmppClient } from '../xmpp/types';
import { useRoomStore, type RoomState } from './room';
import { useSessionStore } from './session';

export type RoomAction = { kind: 'leave'; roomJid: string } | { kind: 'join'; roomJid: string };

const ACTIVE: ReadonlySet<RoomState['status']> = new Set(['joining', 'joined', 'reconnecting']);

/**
 * What to do so the client is in `desired` and nowhere else. Leave first (never when the old room is already
 * failed/left), then join once connected. A room that is already current is left alone whatever its status:
 * the client rejoins suspended rooms itself, and failed/left ones wait for an explicit retry.
 */
export function planRoomActions(input: {
  desired: string | null;
  connected: boolean;
  current: { roomJid: string | null; status: RoomState['status'] };
}): RoomAction[] {
  const { desired, connected, current } = input;
  const actions: RoomAction[] = [];
  if (current.roomJid !== null && current.roomJid !== desired && ACTIVE.has(current.status)) {
    actions.push({ kind: 'leave', roomJid: current.roomJid });
  }
  if (desired !== null && connected && current.roomJid !== desired) {
    actions.push({ kind: 'join', roomJid: desired });
  }
  return actions;
}

/**
 * Keeps the client in the one desired room. TEMPORARY (Phase 3): replaced when geo_service assigns rooms.
 * The effect re-reads the stores so a StrictMode re-run or a quick re-render never joins twice.
 */
export function useAreaRoom(
  client: XmppClient,
  desired: string | null,
  nick: string,
): { retry: () => void } {
  const connected = useSessionStore((s) => s.connection.status === 'connected');
  const roomJid = useRoomStore((s) => s.roomJid);
  const status = useRoomStore((s) => s.status);

  useEffect(() => {
    const { roomJid: currentJid, status: currentStatus } = useRoomStore.getState();
    const actions = planRoomActions({
      desired,
      connected: useSessionStore.getState().connection.status === 'connected',
      current: { roomJid: currentJid, status: currentStatus },
    });
    for (const action of actions) {
      if (action.kind === 'leave') client.leaveRoom(action.roomJid);
      else client.joinRoom(action.roomJid, nick);
    }
  }, [client, desired, connected, roomJid, status, nick]);

  const retry = useCallback(() => {
    if (desired !== null && connected) client.joinRoom(desired, nick);
  }, [client, desired, connected, nick]);

  return { retry };
}
