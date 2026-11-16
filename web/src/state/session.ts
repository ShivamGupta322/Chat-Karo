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
