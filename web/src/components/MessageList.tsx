import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TimelineItem } from '../state/room';
import { toTimelineRows, type TimelineRow } from './timelineRows';

export interface MessageListProps {
  items: TimelineItem[];
  emptyText: string;
}

const NEAR_BOTTOM_PX = 80;

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function MessageRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'message' }>;
}): React.JSX.Element {
  const m = row.message;
  const own = m.isOwn;
  const who = own ? 'You' : (m.nick ?? '');
  const hhmm = time(m.sentAt);
  return (
    <li
      data-kind="message"
      data-own={own ? 'true' : 'false'}
      data-continuation={row.continuation ? 'true' : 'false'}
      title={new Date(m.sentAt).toLocaleString()}
      className={`flex ${own ? 'justify-end' : 'justify-start'} ${row.continuation ? '' : 'mt-2 first:mt-0'}`}
    >
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 sm:max-w-[75%] ${
          own ? 'bg-accent text-on-accent' : 'bg-surface-sunken text-ink'
        }`}
      >
        {row.continuation ? (
          <span className="sr-only">
            {who}, {hhmm}:{' '}
          </span>
        ) : (
          <p
            className={`m-0 flex items-baseline gap-2 text-xs ${
              own ? 'text-on-accent-muted' : 'text-bubble-meta'
            }`}
          >
            <span className="font-semibold">{who}</span>
            <time dateTime={new Date(m.sentAt).toISOString()}>{hhmm}</time>
          </p>
        )}
        <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>
      </div>
    </li>
  );
}

export function MessageList({ items, emptyText }: MessageListProps): React.JSX.Element {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const rows = toTimelineRows(items);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <ol
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="Messages"
      className="m-0 grid h-[55dvh] list-none content-start gap-0.5 overflow-y-auto p-3 sm:p-4 md:h-[62dvh]"
    >
      {rows.length === 0 && (
        <li className="text-center text-sm text-ink-muted">{emptyText}</li>
      )}
      {rows.map((row) => {
        if (row.kind === 'divider') {
          return (
            <li
              key={row.key}
              role="separator"
              aria-label="Earlier messages above"
              className="my-2 flex items-center gap-3 text-xs text-ink-muted"
            >
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
              <span>
                Earlier messages <span aria-hidden="true">↑</span>
              </span>
              <span aria-hidden="true" className="h-px flex-1 bg-line" />
            </li>
          );
        }
        if (row.kind === 'system') {
          return (
            <li
              key={row.key}
              data-kind="system"
              className="my-1 text-center text-xs text-ink-muted [overflow-wrap:anywhere]"
            >
              {row.text}
            </li>
          );
        }
        return <MessageRow key={row.key} row={row} />;
      })}
    </ol>
  );
}
