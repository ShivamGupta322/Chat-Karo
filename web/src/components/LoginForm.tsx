import { useState, type FormEvent } from 'react';
import { toAccountJid } from '../ui/addresses';
import { describeAddressError } from '../ui/text';
import { Wordmark } from './Logo';

export interface LoginFormProps {
  domain: string;
  defaultUsername: string;
  busy: boolean;
  error: string | null;
  onSubmit: (jid: string, password: string) => void;
}

const INPUT =
  'w-full min-w-0 rounded-lg border border-field bg-surface px-3 py-2 text-ink disabled:bg-surface-sunken';

export function LoginForm({
  domain,
  defaultUsername,
  busy,
  error,
  onSubmit,
}: LoginFormProps): React.JSX.Element {
  const [username, setUsername] = useState(defaultUsername);
  // Kept in local component state only; cleared right after submit.
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const res = toAccountJid(username, domain);
    if (!res.ok) {
      setLocalError(describeAddressError('account', res.error, domain));
      return;
    }
    setLocalError(null);
    const pw = password;
    setPassword('');
    onSubmit(res.jid, pw);
  };

  const shownError = localError ?? error;

  return (
    <div className="grid gap-5 rounded-2xl border border-line bg-surface p-6 shadow-sm">
      <div className="grid gap-1">
        <h1 className="m-0">
          <Wordmark />
        </h1>
        <p className="m-0 text-sm text-ink-muted">Chat with people around you</p>
      </div>
      <form onSubmit={handle} className="grid gap-4" aria-labelledby="sign-in-h">
        <div className="flex items-center gap-2">
          <h2 id="sign-in-h" className="m-0 text-base font-semibold">
            Sign in
          </h2>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink">
            Dev
          </span>
        </div>
        <p className="m-0 text-sm text-ink-muted">
          Development sign-in. Use an account from the dev seed (e.g. alice).
        </p>
        <div className="grid gap-1 text-sm">
          <label htmlFor="login-username" className="font-medium">
            Username
          </label>
          <input
            id="login-username"
            className={INPUT}
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="username-hint"
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
          <span id="username-hint" className="text-xs text-ink-muted">
            on {domain}
          </span>
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="login-password" className="font-medium">
            Password
          </label>
          <input
            id="login-password"
            className={INPUT}
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </div>
        {shownError !== null && (
          <p role="alert" className="m-0 text-sm text-danger">
            {shownError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
