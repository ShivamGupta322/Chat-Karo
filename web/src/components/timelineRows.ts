import type { TimelineItem } from '../state/room';
import type { ChatMessage } from '../xmpp';

export const GROUP_WINDOW_MS = 5 * 60_000;

export type TimelineRow =
  | { kind: 'message'; key: string; message: ChatMessage; continuation: boolean }
  | { kind: 'system'; key: string; text: string; at: number } // notices + room messages (nick === null)
  | { kind: 'divider'; key: 'earlier-divider' };

/**
 * Turns the store timeline into display rows: groups consecutive messages from the same sender,
 * and inserts one "earlier messages" divider directly after the last history message.
 */
export function toTimelineRows(items: readonly TimelineItem[]): TimelineRow[] {
  let lastHistory = -1;
  items.forEach((item, i) => {
    if (item.kind === 'message' && item.message.isHistory) lastHistory = i;
  });

  const rows: TimelineRow[] = [];
  items.forEach((item, i) => {
    if (item.kind === 'notice') {
      rows.push({ kind: 'system', key: item.id, text: item.text, at: item.at });
    } else if (item.message.nick === null) {
      const m = item.message;
      rows.push({ kind: 'system', key: `m-${m.id}`, text: m.body, at: m.sentAt });
    } else {
      const m = item.message;
      const prev = rows.at(-1);
      const continuation =
        prev !== undefined &&
        prev.kind === 'message' &&
        prev.message.nick === m.nick &&
        prev.message.isOwn === m.isOwn &&
        Math.abs(m.sentAt - prev.message.sentAt) <= GROUP_WINDOW_MS;
      rows.push({ kind: 'message', key: `m-${m.id}`, message: m, continuation });
    }
    if (i === lastHistory) rows.push({ kind: 'divider', key: 'earlier-divider' });
  });
  return rows;
}
