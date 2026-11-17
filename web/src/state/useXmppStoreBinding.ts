import { useEffect } from 'react';
import type { XmppClient } from '../xmpp/types';
import { bindXmppToStores } from './bindXmpp';

/** Routes client events into the stores for as long as the calling component is mounted. */
export function useXmppStoreBinding(client: XmppClient): void {
  useEffect(() => bindXmppToStores(client), [client]);
}
