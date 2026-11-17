import type { XmppClient } from '../xmpp/types';
import { useRoomStore } from './room';
import { useSessionStore } from './session';

/** Routes client events into the Zustand stores. Returns an unsubscribe function. */
export function bindXmppToStores(client: XmppClient): () => void {
  useSessionStore.getState().setConnection(client.getState());
  return client.subscribe((event) => {
    if (event.type === 'connection') useSessionStore.getState().setConnection(event.state);
    // The room store also sees connection events: a terminal disconnect clears its timeline.
    useRoomStore.getState().apply(event);
  });
}
