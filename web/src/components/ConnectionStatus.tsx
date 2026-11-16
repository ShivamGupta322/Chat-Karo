import { bareJid, type ConnectionState } from '../xmpp';
import { describeConnectionError } from './describe';

function label(state: ConnectionState): string {
  switch (state.status) {
    case 'idle':
      return 'Not connected';
    case 'connecting':
      return 'Connecting...';
    case 'connected':
      return `Connected as ${bareJid(state.jid)}`;
    case 'disconnecting':
      return 'Disconnecting...';
    case 'disconnected':
      return state.error ? describeConnectionError(state.error) : 'Disconnected';
  }
}

export function ConnectionStatus({ state }: { state: ConnectionState }): React.JSX.Element {
  return (
    <p role="status" className="min-w-0 truncate text-sm text-slate-600">
      {label(state)}
    </p>
  );
}
