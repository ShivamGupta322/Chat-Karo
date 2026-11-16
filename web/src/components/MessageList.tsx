import { useEffect, useLayoutEffect, useRef } from 'react';
import type { TimelineItem } from '../state/room';

export interface MessageListProps {
  items: TimelineItem[];
  selfNick: string | null;
}

const NEAR_BOTTOM_PX = 80;

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageList({ items, selfNick }: MessageListProps): React.JSX.Element {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

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
      className="grid h-72 list-none content-start gap-1 overflow-y-auto p-0 md:h-96"
    >
      {items.length === 0 && <li className="text-sm text-slate-500">No messages yet</li>}
      {items.map((item) => {
        if (item.kind === 'notice') {
          return (
            <li key={item.id} className="text-sm italic text-slate-500">
              {item.text}
            </li>
          );
        }
        const m = item.message;
        if (m.nick === null) {
          return (
            <li key={`m-${m.id}`} className="text-sm italic text-slate-500">
              {m.body}
            </li>
          );
        }
        const own = m.nick === selfNick || m.isOwn;
        return (
          <li
            key={`m-${m.id}`}
            data-own={own ? 'true' : 'false'}
            className={`[overflow-wrap:anywhere] ${own ? 'text-blue-900' : ''} ${m.isHistory ? 'opacity-70' : ''}`}
          >
            <span className="text-xs text-slate-500">{time(m.sentAt)} </span>
            <span className="font-semibold">{m.nick}</span>
            {m.isHistory && <span className="sr-only"> (earlier)</span>}
            {': '}
            <span>{m.body}</span>
          </li>
        );
      })}
    </ol>
  );
}
