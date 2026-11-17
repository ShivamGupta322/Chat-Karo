import { selectSessionJid } from '../state/session';
import { localpartOf, type ConnectionState } from '../xmpp';
import { ConnectionStatus } from './ConnectionStatus';
import { Wordmark } from './Logo';

export interface AppHeaderProps {
  connection: ConnectionState;
  onSignOut: () => void;
}

export function AppHeader({ connection, onSignOut }: AppHeaderProps): React.JSX.Element {
  const sessionJid = selectSessionJid(connection);
  const name = sessionJid === null ? '' : localpartOf(sessionJid);
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
        <h1 className="m-0">
          <Wordmark />
        </h1>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ConnectionStatus state={connection} />
          {name !== '' && <span className="min-w-0 max-w-40 truncate text-sm">{name}</span>}
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
