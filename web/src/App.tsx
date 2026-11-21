import { IdentityNotice } from './components/IdentityNotice';
import { Chat } from './pages/Chat';
import { Welcome } from './pages/Welcome';
import { selectAppView, useIdentityStore } from './state/identity';
import { useIdentityController } from './state/IdentityProvider';
import { useSessionStore } from './state/session';
import { useXmppStoreBinding } from './state/useXmppStoreBinding';
import { useXmppClient } from './xmpp';

export interface AppProps {
  mucDomain: string;
  mapTileUrl: string | null;
}

export function App({ mucDomain, mapTileUrl }: AppProps): React.JSX.Element {
  useXmppStoreBinding(useXmppClient());
  const identity = useIdentityController();
  const id = useIdentityStore();
  const connection = useSessionStore((s) => s.connection);
  // 'reconnecting' keeps the chat on screen: a dropped connection must not bounce the user to Welcome.
  const view = selectAppView(id, connection);

  switch (view.kind) {
    case 'onboarding':
      return (
        <Welcome
          view="new"
          busy={view.busy}
          error={view.error}
          onCreate={(nickname) => {
            void identity.onboard(nickname);
          }}
        />
      );
    case 'connecting':
      return <Welcome view="connecting" nickname={view.nickname} onCancel={identity.signOut} />;
    case 'returning':
      return (
        <Welcome
          view="returning"
          nickname={view.nickname}
          busy={view.busy}
          error={view.error}
          onContinue={identity.continueSession}
          onStartOver={identity.startOver}
        />
      );
    case 'chat':
      return (
        <Chat
          mucDomain={mucDomain}
          mapTileUrl={mapTileUrl}
          nickname={view.nickname}
          onSignOut={identity.signOut}
          banner={
            <IdentityNotice
              remembered={id.remembered}
              identityInvalid={id.token === 'identity-invalid'}
              onStartOver={identity.startOver}
            />
          }
        />
      );
  }
}
