import type { XmppClient } from '../xmpp/types';
import { useRoomStore } from './room';
import { useSessionStore } from './session';

/** Routes client events into the Zustand stores. Returns an unsubscribe function. */
export function bindXmppToStores(client: XmppClient): () => void {
  useSessionStore.getState().setConnection(client.getState());
  return client.subscribe((event) => {
    if (event.type === 'connection') useSessionStore.getState().setConnection(event.state);
    else useRoomStore.getState().apply(event);
  });
}
