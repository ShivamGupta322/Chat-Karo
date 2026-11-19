import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { TimelineItem } from '../state/room';
import { HISTORY_TEXT } from '../ui/text';
import { nextScrollTop, type ScrollSnapshot } from './scrollAnchor';
import { toTimelineRows, type TimelineRow } from './timelineRows';

export interface MessageListProps {
  items: TimelineItem[];
  emptyText: string;
  /** True while history is loading; exposed to assistive tech as aria-busy. */
  busy?: boolean;
  /** null/undefined = "Load earlier" not offered */
  earlier?: { status: 'idle' | 'loading' | 'failed'; onLoad: () => void } | null;
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
      data-row-key={row.key}
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

/** The first row of the list and its offsetTop. Walks children: row keys may contain characters unsafe in selectors. */
function readFirst(list: HTMLOListElement): ScrollSnapshot {
  const first = list.children[0];
  if (!(first instanceof HTMLElement)) return { firstKey: null, firstTop: 0 };
  return { firstKey: first.getAttribute('data-row-key'), firstTop: first.offsetTop };
}

function topOfKey(list: HTMLOListElement, key: string): number | null {
  for (const child of Array.from(list.children)) {
    if (child instanceof HTMLElement && child.getAttribute('data-row-key') === key) {
      return child.offsetTop;
    }
  }
  return null;
}

export function MessageList({
  items,
  emptyText,
  busy,
  earlier,
}: MessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const snap = useRef<ScrollSnapshot>({ firstKey: null, firstTop: 0 });
  const prevEarlierLoading = useRef(false);
  const buttonFocused = useRef(false);
  const hadBlock = useRef(false);
  const statusId = useId();
  const rows = toTimelineRows(items);
  const status = earlier?.status;
  const hasBlock = earlier !== null && earlier !== undefined;

  useEffect(() => {
    const el = scrollRef.current;
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
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const now = readFirst(list);
    const prevKey = snap.current.firstKey;
    const next = nextScrollTop({
      prev: snap.current,
      firstKeyNow: now.firstKey,
      prevKeyTopNow: prevKey === null ? null : topOfKey(list, prevKey),
      earlierJustLoaded: prevEarlierLoading.current && status !== 'loading',
      stick: stick.current,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    });
    if (next !== null) scroller.scrollTop = next;
    snap.current = now;
    prevEarlierLoading.current = status === 'loading';
  }, [items, status]);

  // When the button goes away while it has focus, keep keyboard users in the message area.
  useLayoutEffect(() => {
    if (hadBlock.current && !hasBlock && buttonFocused.current) {
      listRef.current?.focus({ preventScroll: true });
      buttonFocused.current = false;
    }
    hadBlock.current = hasBlock;
  }, [hasBlock]);

  const label =
    status === 'loading'
      ? HISTORY_TEXT.loadingEarlier
      : status === 'failed'
        ? HISTORY_TEXT.retry
        : HISTORY_TEXT.loadEarlier;

  return (
    <div
      ref={scrollRef}
      className="relative h-[55dvh] overflow-y-auto p-3 sm:p-4 md:h-auto md:min-h-0 md:flex-1"
    >
      {hasBlock && (
        <div className="mb-2 flex flex-col items-center gap-1">
          <button
            type="button"
            aria-disabled={status === 'loading' ? 'true' : undefined}
            aria-describedby={status === 'failed' ? statusId : undefined}
            onFocus={() => {
              buttonFocused.current = true;
            }}
            onBlur={(e) => {
              // A blur caused by the button being removed must not forget that it had focus.
              if (e.currentTarget.isConnected) buttonFocused.current = false;
            }}
            onClick={() => {
              if (status === 'loading') return;
              if (listRef.current) snap.current = readFirst(listRef.current);
              earlier.onLoad();
            }}
            className="rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken aria-disabled:cursor-progress aria-disabled:text-ink-muted"
          >
            {label}
          </button>
          <p id={statusId} role="status" className="m-0 min-h-4 text-xs text-ink-muted">
            {status === 'failed' ? HISTORY_TEXT.earlierFailed : null}
          </p>
        </div>
      )}
      <ol
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Messages"
        aria-busy={busy || status === 'loading' ? 'true' : undefined}
        tabIndex={-1}
        className="m-0 grid list-none content-start gap-0.5 p-0"
      >
        {rows.length === 0 && (
          <li className="text-center text-sm text-ink-muted">{emptyText}</li>
        )}
        {rows.map((row) => {
          if (row.kind === 'divider') {
            return (
              <li
                key={row.key}
                data-row-key={row.key}
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
                data-row-key={row.key}
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
    </div>
  );
}
