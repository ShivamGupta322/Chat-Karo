import { LoginForm } from '../components/LoginForm';
import { useSessionStore } from '../state/session';
import { describeConnectionError } from '../ui/text';
import { useXmppClient } from '../xmpp';

export function DevLogin({ xmppDomain }: { xmppDomain: string }): React.JSX.Element {
  const client = useXmppClient();
  const connection = useSessionStore((s) => s.connection);
  const busy = connection.status === 'connecting' || connection.status === 'disconnecting';
  const error =
    connection.status === 'disconnected' && connection.error
      ? describeConnectionError(connection.error)
      : null;

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center p-4">
      <LoginForm
        domain={xmppDomain}
        defaultUsername="alice"
        busy={busy}
        error={error}
        onSubmit={(jid, pw) => {
          client.connect(jid, pw);
        }}
      />
    </main>
  );
}
