import { CONNECTION_TEXT } from '../ui/text';
import type { ConnectionState } from '../xmpp';

const VIEW = {
  idle: { text: 'Offline', dot: 'bg-ink-muted' },
  disconnected: { text: 'Offline', dot: 'bg-ink-muted' },
  connecting: { text: 'Connecting…', dot: 'bg-warning' },
  connected: { text: 'Online', dot: 'bg-success' },
  reconnecting: { text: CONNECTION_TEXT.statusReconnecting, dot: 'bg-warning' },
  disconnecting: { text: 'Signing out…', dot: 'bg-warning' },
} satisfies Record<ConnectionState['status'], { text: string; dot: string }>;

export function ConnectionStatus({ state }: { state: ConnectionState }): React.JSX.Element {
  const view = VIEW[state.status];
  return (
    <p
      role="status"
      className="m-0 inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${view.dot}`} />
      {view.text}
    </p>
  );
}
