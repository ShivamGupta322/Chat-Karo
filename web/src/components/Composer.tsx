import { useState, type FormEvent } from 'react';
import { describeSendError } from '../ui/text';
import { MAX_MESSAGE_LENGTH, type SendResult } from '../xmpp';

export interface ComposerProps {
  disabled: boolean;
  onSend: (body: string) => SendResult;
}

export function Composer({ disabled, onSend }: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const remaining = MAX_MESSAGE_LENGTH - [...text].length;

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    if (disabled) return;
    const res = onSend(text);
    if (res.ok) {
      setText('');
      setError(null);
    } else {
      setError(describeSendError(res.error));
    }
  };

  return (
    <form onSubmit={handle} className="grid gap-1" aria-label="Send a message">
      <div className="flex items-center gap-2">
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <input
          id="composer-input"
          className="min-w-0 flex-1 rounded-full border border-field bg-surface px-4 py-2 text-ink disabled:bg-surface-sunken"
          placeholder="Message the room…"
          value={text}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
        <button
          type="submit"
          disabled={disabled}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-accent px-4 py-2 font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4 20-7z" />
          </svg>
          <span className="sr-only sm:not-sr-only">Send</span>
        </button>
      </div>
      {remaining < 200 && <p className="m-0 text-xs text-ink-muted">{remaining} characters left</p>}
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
