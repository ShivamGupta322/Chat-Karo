import { LoginForm } from '../components/LoginForm';
import { describeConnectionError } from '../components/describe';
import { useSessionStore } from '../state/session';
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
    <main className="mx-auto max-w-sm p-4">
      <h1 className="mb-1 text-xl font-semibold">chatErl</h1>
      <p className="mb-4 text-sm text-slate-600">Dev login</p>
      <LoginForm
        defaultJid={`alice@${xmppDomain}`}
        busy={busy}
        error={error}
        onSubmit={(jid, pw) => {
          client.connect(jid, pw);
        }}
      />
    </main>
  );
}
