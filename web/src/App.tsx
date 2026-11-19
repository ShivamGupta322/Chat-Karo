import { Chat } from './pages/Chat';
import { DevLogin } from './pages/DevLogin';
import { useSessionStore } from './state/session';
import { useXmppStoreBinding } from './state/useXmppStoreBinding';
import { useXmppClient } from './xmpp';

export interface AppProps {
  xmppDomain: string;
  mucDomain: string;
  mapTileUrl: string | null;
}

export function App({ xmppDomain, mucDomain, mapTileUrl }: AppProps): React.JSX.Element {
  useXmppStoreBinding(useXmppClient());
  // 'reconnecting' keeps the chat on screen: a dropped connection must not bounce the user to login.
  const inSession = useSessionStore(
    (s) => s.connection.status === 'connected' || s.connection.status === 'reconnecting',
  );
  return inSession ? <Chat mucDomain={mucDomain} mapTileUrl={mapTileUrl} /> : <DevLogin xmppDomain={xmppDomain} />;
}
