import { Chat } from './pages/Chat';
import { DevLogin } from './pages/DevLogin';
import { useSessionStore } from './state/session';
import { useXmppStoreBinding } from './state/useXmppStoreBinding';
import { useXmppClient } from './xmpp';

export interface AppProps {
  xmppDomain: string;
  mucDomain: string;
}

export function App({ xmppDomain, mucDomain }: AppProps): React.JSX.Element {
  useXmppStoreBinding(useXmppClient());
  const connected = useSessionStore((s) => s.connection.status === 'connected');
  return connected ? <Chat mucDomain={mucDomain} /> : <DevLogin xmppDomain={xmppDomain} />;
}
