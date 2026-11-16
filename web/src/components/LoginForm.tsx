import { useState, type FormEvent } from 'react';

export interface LoginFormProps {
  defaultJid: string;
  busy: boolean;
  error: string | null;
  onSubmit: (jid: string, password: string) => void;
}

export function LoginForm({ defaultJid, busy, error, onSubmit }: LoginFormProps): React.JSX.Element {
  const [jid, setJid] = useState(defaultJid);
  // Kept in local component state only; cleared right after submit.
  const [password, setPassword] = useState('');

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const pw = password;
    setPassword('');
    onSubmit(jid.trim(), pw);
  };

  return (
    <form onSubmit={handle} className="grid gap-3" aria-label="Log in">
      <label className="grid gap-1 text-sm">
        JID
        <input
          className="rounded border border-slate-300 px-2 py-1.5"
          value={jid}
          autoComplete="username"
          required
          onChange={(e) => {
            setJid(e.target.value);
          }}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Password
        <input
          className="rounded border border-slate-300 px-2 py-1.5"
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
      </label>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
      >
        {busy ? 'Connecting...' : 'Log in'}
      </button>
    </form>
  );
}
