import { useState, type FormEvent } from 'react';
import { MAX_MESSAGE_LENGTH, type SendResult } from '../xmpp';

export interface ComposerProps {
  disabled: boolean;
  onSend: (body: string) => SendResult;
}

const ERRORS = {
  empty: 'Type a message first',
  'too-long': `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`,
  'not-connected': 'You are not connected',
  'not-joined': 'Join a room first',
} as const;

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
      setError(ERRORS[res.error]);
    }
  };

  return (
    <form onSubmit={handle} className="grid gap-1" aria-label="Send a message">
      <div className="flex gap-2">
        <label className="grid flex-1 gap-1 text-sm">
          Message
          <input
            className="rounded border border-slate-300 px-2 py-1.5 disabled:bg-slate-100"
            value={text}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </label>
        <button
          type="submit"
          disabled={disabled}
          className="self-end rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {remaining < 200 && (
        <p className="text-xs text-slate-500">{remaining} characters left</p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
