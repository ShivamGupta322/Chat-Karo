import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { bindXmppToStores } from '../state/bindXmpp';
import { installPageHideClose } from './pageHide';
import type { XmppClient } from './types';

const XmppContext = createContext<XmppClient | null>(null);

export function XmppProvider({
  client,
  children,
}: {
  client: XmppClient;
  children: ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const removePageHide = installPageHideClose(client);
    const unbind = bindXmppToStores(client);
    // No client.disconnect() here: StrictMode runs effects twice in dev and would kill the session.
    return () => {
      removePageHide();
      unbind();
    };
  }, [client]);
  return <XmppContext.Provider value={client}>{children}</XmppContext.Provider>;
}

export function useXmppClient(): XmppClient {
  const client = useContext(XmppContext);
  if (!client) throw new Error('useXmppClient must be used inside <XmppProvider>');
  return client;
}
