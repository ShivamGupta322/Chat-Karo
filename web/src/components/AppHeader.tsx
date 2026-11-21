import { IDENTITY_TEXT } from '../ui/text';
import type { ConnectionState } from '../xmpp';
import { ConnectionStatus } from './ConnectionStatus';
import { Wordmark } from './Logo';

export interface AppHeaderProps {
  connection: ConnectionState;
  /** The profile nickname. Never a JID. */
  name: string;
  onSignOut: () => void;
}

export function AppHeader({ connection, name, onSignOut }: AppHeaderProps): React.JSX.Element {
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
            {IDENTITY_TEXT.signOut}
          </button>
        </div>
      </div>
    </header>
  );
}
