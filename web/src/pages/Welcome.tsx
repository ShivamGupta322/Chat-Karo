import { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateNickname } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Wordmark } from '../components/Logo';
import type { OnboardError } from '../state/identity';
import { IDENTITY_TEXT, describeConnectionError, describeOnboardError } from '../ui/text';
import type { ConnectionError } from '../xmpp';

export type WelcomeProps =
  | {
      view: 'new';
      busy: boolean;
      error: OnboardError | null;
      onCreate: (nickname: string) => void;
    }
  | {
      view: 'returning';
      nickname: string;
      busy: boolean;
      error: ConnectionError | null;
      onContinue: () => void;
      onStartOver: () => void;
    }
  | { view: 'connecting'; nickname: string; onCancel: () => void };

const INPUT =
  'w-full min-w-0 rounded-lg border border-field bg-surface px-3 py-2 text-ink';
const PRIMARY =
  'rounded-lg bg-accent px-3 py-2 font-medium text-on-accent hover:bg-accent-strong aria-disabled:opacity-50';
const SECONDARY =
  'rounded-lg border border-field bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-sunken aria-disabled:opacity-50';

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center p-4">
      <div className="grid gap-5 rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <div className="grid gap-1">
          <h1 className="m-0">
            <Wordmark />
          </h1>
          <p className="m-0 text-sm text-ink-muted">{IDENTITY_TEXT.tagline}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

// Focus is lost to <body> when the previous view (and the button that was focused) unmounts. Land on the
// heading: it announces the new context, raises no mobile keyboard, and one Tab reaches the first control.
// Never steals focus that is somewhere real.
function useHeadingFocus(): React.RefObject<HTMLHeadingElement> {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const a = document.activeElement;
    if (a === null || a === document.body || !a.isConnected) ref.current?.focus();
  }, []);
  return ref;
}

function NewView({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error: OnboardError | null;
  onCreate: (nickname: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<'empty' | 'invalid' | null>(null);
  // The value the server last judged: its error is stale as soon as the input changes.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useHeadingFocus();

  const serverError = error !== null && submitted === value ? error : null;
  const fieldError: OnboardError | null =
    localError ?? (serverError === 'invalid' || serverError === 'taken' ? serverError : null);
  const alertError =
    serverError === 'unavailable' || serverError === 'failed' ? serverError : null;

  useEffect(() => {
    if (!busy && (error === 'invalid' || error === 'taken')) inputRef.current?.focus();
  }, [error, busy]);

  const handle = (e: FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    const v = validateNickname(value);
    if (!v.ok) {
      setLocalError(v.error);
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    setSubmitted(value);
    onCreate(v.value);
  };

  const describedBy = fieldError === null ? 'nickname-hint' : 'nickname-hint nickname-error';

  return (
    <Shell>
      <form onSubmit={handle} className="grid gap-4" aria-labelledby="welcome-heading" noValidate>
        <h2
          ref={headingRef}
          id="welcome-heading"
          tabIndex={-1}
          className="m-0 text-base font-semibold focus:outline-none"
        >
          {IDENTITY_TEXT.heading}
        </h2>
        <p className="m-0 text-sm text-ink-muted">{IDENTITY_TEXT.deviceNote}</p>
        <div className="grid gap-1 text-sm">
          <label htmlFor="nickname" className="font-medium">
            {IDENTITY_TEXT.nicknameLabel}
          </label>
          <input
            ref={inputRef}
            id="nickname"
            className={INPUT}
            value={value}
            maxLength={20}
            autoComplete="nickname"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={fieldError === null ? undefined : true}
            onChange={(e) => {
              setValue(e.target.value);
              setLocalError(null);
            }}
          />
          <span id="nickname-hint" className="text-xs text-ink-muted">
            {IDENTITY_TEXT.nicknameHint}
          </span>
          {fieldError !== null && (
            <p id="nickname-error" className="m-0 text-sm text-danger">
              {describeOnboardError(fieldError)}
            </p>
          )}
        </div>
        {alertError !== null && (
          <p role="alert" className="m-0 text-sm text-danger">
            {describeOnboardError(alertError)}
          </p>
        )}
        {/* aria-disabled, not disabled: focus stays on the button while the request runs (ADR-012). */}
        <button type="submit" aria-disabled={busy} className={PRIMARY}>
          {busy ? IDENTITY_TEXT.creating : IDENTITY_TEXT.submit}
        </button>
      </form>
    </Shell>
  );
}

function ReturningView({
  nickname,
  busy,
  error,
  onContinue,
  onStartOver,
}: {
  nickname: string;
  busy: boolean;
  error: ConnectionError | null;
  onContinue: () => void;
  onStartOver: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const headingRef = useHeadingFocus();
  return (
    <Shell>
      <section aria-labelledby="welcome-heading" className="grid gap-4">
        <h2
          ref={headingRef}
          id="welcome-heading"
          tabIndex={-1}
          className="m-0 text-base font-semibold focus:outline-none"
        >
          {IDENTITY_TEXT.returningHeading}
        </h2>
        <p className="m-0 min-w-0 break-words font-medium">{nickname}</p>
        {error !== null && (
          <p role="alert" className="m-0 text-sm text-danger">
            {describeConnectionError(error)}
          </p>
        )}
        <div className="grid gap-2">
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onContinue();
            }}
            className={PRIMARY}
          >
            {error === null ? IDENTITY_TEXT.continueAs(nickname) : IDENTITY_TEXT.tryAgain}
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) setConfirming(true);
            }}
            className={SECONDARY}
          >
            {IDENTITY_TEXT.startOver}
          </button>
        </div>
      </section>
      {confirming && (
        <ConfirmDialog
          title={IDENTITY_TEXT.confirmTitle}
          body={IDENTITY_TEXT.confirmBody}
          confirmLabel={IDENTITY_TEXT.confirmAction}
          cancelLabel={IDENTITY_TEXT.cancel}
          onConfirm={() => {
            setConfirming(false);
            onStartOver();
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      )}
    </Shell>
  );
}

export function Welcome(props: WelcomeProps): React.JSX.Element {
  switch (props.view) {
    case 'new':
      return <NewView busy={props.busy} error={props.error} onCreate={props.onCreate} />;
    case 'returning':
      return (
        <ReturningView
          nickname={props.nickname}
          busy={props.busy}
          error={props.error}
          onContinue={props.onContinue}
          onStartOver={props.onStartOver}
        />
      );
    case 'connecting':
      return (
        <Shell>
          <div className="grid gap-4">
            <p role="status" className="m-0 break-words">
              {IDENTITY_TEXT.connecting(props.nickname)}
            </p>
            <button type="button" onClick={props.onCancel} className={SECONDARY}>
              {IDENTITY_TEXT.cancel}
            </button>
          </div>
        </Shell>
      );
  }
}
