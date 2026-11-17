import { create } from 'zustand';
import type { ConnectionState } from '../xmpp/types';

interface SessionStore {
  connection: ConnectionState;
  setConnection: (c: ConnectionState) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  connection: { status: 'idle' },
  setConnection: (connection) => {
    set({ connection });
  },
}));

/** The last bound full JID while connected or reconnecting, else null. */
export function selectSessionJid(c: ConnectionState): string | null {
  return c.status === 'connected' || c.status === 'reconnecting' ? c.jid : null;
}
