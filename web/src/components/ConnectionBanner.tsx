import { useEffect, useState } from 'react';
import { CONNECTION_TEXT } from '../ui/text';
import type { ConnectionState } from '../xmpp';

export interface ConnectionBannerProps {
  state: Extract<ConnectionState, { status: 'reconnecting' }>;
  onRetryNow: () => void;
  now?: () => number;
}

export function ConnectionBanner({
  state,
  onRetryNow,
  now = Date.now,
}: ConnectionBannerProps): React.JSX.Element {
  const { nextAttemptAt } = state;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (nextAttemptAt === null) return undefined;
    const id = setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [nextAttemptAt]);

  const countdown =
    nextAttemptAt === null
      ? CONNECTION_TEXT.bannerRetrying
      : CONNECTION_TEXT.bannerRetryIn(Math.max(0, Math.ceil((nextAttemptAt - now()) / 1000)));

  return (
    <div className="border-b border-line bg-surface-sunken text-ink">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm sm:px-4">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />
        {/* Static text only: a live region that changed every second would be announced every second. */}
        <div role="status" className="m-0 flex min-w-0 flex-wrap gap-x-2">
          <span className="font-medium">{CONNECTION_TEXT.bannerLost}</span>
          <span>{CONNECTION_TEXT.bannerAutoRetry}</span>
        </div>
        <span aria-hidden="true" className="text-bubble-meta">
          {countdown}
        </span>
        <button
          type="button"
          onClick={onRetryNow}
          className="rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken"
        >
          {CONNECTION_TEXT.retryNow}
        </button>
      </div>
    </div>
  );
}
