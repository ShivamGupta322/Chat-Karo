import { describe, expect, it } from 'vitest';
import { GROUP_WINDOW_MS, toTimelineRows } from '../../src/components/timelineRows';
import type { TimelineItem } from '../../src/state/room';

interface Opts {
  at?: number;
  history?: boolean;
  own?: boolean;
}
const msg = (id: string, nick: string | null, o: Opts = {}): TimelineItem => ({
  kind: 'message',
  message: {
    id,
    roomJid: 'r@m',
    nick,
    body: `body-${id}`,
    sentAt: o.at ?? 0,
    isHistory: o.history ?? false,
    isOwn: o.own ?? false,
  },
});
const notice = (id: string, at = 0): TimelineItem => ({ kind: 'notice', id, text: id, at });
const cont = (items: TimelineItem[]): (boolean | string)[] =>
  toTimelineRows(items).map((r) => (r.kind === 'message' ? r.continuation : r.kind));

describe('toTimelineRows', () => {
  it('groups consecutive messages from the same sender within the window', () => {
    expect(
      cont([msg('1', 'bob'), msg('2', 'bob', { at: 60_000 }), msg('3', 'bob', { at: 120_000 })]),
    ).toEqual([false, true, true]);
  });

  it('allows exactly the window and breaks after it', () => {
    expect(cont([msg('1', 'bob'), msg('2', 'bob', { at: GROUP_WINDOW_MS })])).toEqual([false, true]);
    expect(cont([msg('1', 'bob'), msg('2', 'bob', { at: 6 * 60_000 })])).toEqual([false, false]);
  });

  it('a different nick breaks the group', () => {
    expect(cont([msg('1', 'bob'), msg('2', 'carol')])).toEqual([false, false]);
  });

  it('own after other breaks the group', () => {
    expect(cont([msg('1', 'alice'), msg('2', 'alice', { own: true })])).toEqual([false, false]);
  });

  it('a notice between two messages breaks the group', () => {
    expect(cont([msg('1', 'bob'), notice('n1'), msg('2', 'bob')])).toEqual([
      false,
      'system',
      false,
    ]);
  });

  it('inserts exactly one divider directly after the last history message', () => {
    const rows = toTimelineRows([
      msg('1', 'bob', { history: true }),
      msg('2', 'bob', { history: true }),
      msg('3', 'bob'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'message', 'divider', 'message']);
    const live = rows[3];
    expect(live?.kind === 'message' && live.continuation).toBe(false);
  });

  it('adds no divider without history', () => {
    const rows = toTimelineRows([msg('1', 'bob'), msg('2', 'carol')]);
    expect(rows.some((r) => r.kind === 'divider')).toBe(false);
  });

  it('puts the divider at the end when everything is history', () => {
    const rows = toTimelineRows([msg('1', 'bob', { history: true })]);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'divider']);
  });

  it('after a catch-up the single divider sits below the caught-up block', () => {
    const rows = toTimelineRows([
      msg('old', 'bob'),
      msg('gap1', 'carol', { history: true }),
      msg('gap2', 'carol', { history: true }),
      msg('live', 'bob'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'message', 'message', 'divider', 'message']);
    expect(rows.filter((r) => r.kind === 'divider')).toHaveLength(1);
    expect(rows[3]?.key).toBe('earlier-divider');
  });

  it('earlier history prepended above the history and live block keeps one divider after the same last history message', () => {
    const before = toTimelineRows([
      msg('h1', 'bob', { history: true }),
      msg('h2', 'bob', { history: true }),
      msg('live', 'carol'),
    ]);
    const after = toTimelineRows([
      msg('e1', 'dave', { history: true }),
      msg('e2', 'dave', { history: true }),
      msg('h1', 'bob', { history: true }),
      msg('h2', 'bob', { history: true }),
      msg('live', 'carol'),
    ]);
    expect(after.filter((r) => r.kind === 'divider')).toHaveLength(1);
    const dividerAt = after.findIndex((r) => r.kind === 'divider');
    expect(after[dividerAt - 1]?.key).toBe('m-h2');
    expect(after[dividerAt + 1]?.key).toBe('m-live');
    expect(before.findIndex((r) => r.kind === 'divider')).toBe(2);
  });

  it('turns nick-null messages into system rows', () => {
    expect(toTimelineRows([msg('1', null)])).toEqual([
      { kind: 'system', key: 'm-1', text: 'body-1', at: 0 },
    ]);
  });

  it('keys messages and notices distinctly', () => {
    const keys = toTimelineRows([msg('1', 'bob'), notice('notice-7')]).map((r) => r.key);
    expect(keys).toEqual(['m-1', 'notice-7']);
  });
});
