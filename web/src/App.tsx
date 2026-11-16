import { Chat } from './pages/Chat';
import { DevLogin } from './pages/DevLogin';
import { useSessionStore } from './state/session';

export interface AppProps {
  xmppDomain: string;
  mucDomain: string;
}

export function App({ xmppDomain, mucDomain }: AppProps): React.JSX.Element {
  const connected = useSessionStore((s) => s.connection.status === 'connected');
  return connected ? <Chat mucDomain={mucDomain} /> : <DevLogin xmppDomain={xmppDomain} />;
}
