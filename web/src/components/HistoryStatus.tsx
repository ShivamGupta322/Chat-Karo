import type { RoomHistory } from '../state/room';
import { HISTORY_TEXT } from '../ui/text';

export interface HistoryStatusProps {
  history: RoomHistory;
  onRetry: () => void;
}

export function HistoryStatus({ history, onRetry }: HistoryStatusProps): React.JSX.Element | null {
  if (history.loading) {
    return (
      <p role="status" className="m-0 border-b border-line px-3 py-2 text-sm text-ink-muted">
        {HISTORY_TEXT.loading}
      </p>
    );
  }
  if (history.failed) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2 text-sm text-ink-muted"
      >
        <span>{HISTORY_TEXT.failed}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken"
        >
          {HISTORY_TEXT.retry}
        </button>
      </div>
    );
  }
  return null;
}
