import { describe, expect, it } from 'vitest';
import {
  MAX_TIMELINE,
  initialRoomState,
  mergeHistory,
  reduceRoom,
  type RoomState,
  type TimelineItem,
} from '../../src/state/room';
import { HISTORY_TEXT } from '../../src/ui/text';
import type { ChatMessage, XmppEvent } from '../../src/xmpp/types';

const A = 'lobby@muc.chaterl.localhost';
const B = 'other@muc.chaterl.localhost';

function run(events: XmppEvent[], from: RoomState = initialRoomState): RoomState {
  return events.reduce(reduceRoom, from);
}

function msg(id: string, roomJid = A, nick: string | null = 'bob'): XmppEvent {
  const message: ChatMessage = {
    id,
    roomJid,
    nick,
    body: `body ${id}`,
    sentAt: 1,
    isHistory: false,
    isOwn: false,
  };
  return { type: 'message', message };
}

function hmsg(id: string, sentAt = 1, roomJid = A): ChatMessage {
  return { id, roomJid, nick: 'bob', body: `body ${id}`, sentAt, isHistory: true, isOwn: false };
}

const joining = (roomJid: string, nick = 'alice'): XmppEvent => ({
  type: 'room-joining',
  roomJid,
  nick,
});

describe('reduceRoom', () => {
  it('room-joining sets the current room and resets when the room changes', () => {
    const s1 = run([joining(A), msg('1')]);
    expect(s1.roomJid).toBe(A);
    expect(s1.status).toBe('joining');
    expect(s1.timeline).toHaveLength(1);
    const s2 = reduceRoom(s1, joining(B));
    expect(s2.roomJid).toBe(B);
    expect(s2.timeline).toHaveLength(0);
    expect(s2.occupants).toEqual([]);
  });

  it('a nick retry keeps the timeline', () => {
    const s1 = run([joining(A), msg('1')]);
    const s2 = reduceRoom(s1, joining(A, 'alice-2'));
    expect(s2.timeline).toHaveLength(1);
    expect(s2.nick).toBe('alice-2');
  });

  it('events for another room return the same reference', () => {
    const s = run([joining(A)]);
    const events: XmppEvent[] = [
      msg('1', B),
      { type: 'occupant-joined', roomJid: B, nick: 'x', isSelf: false },
      { type: 'room-left', roomJid: B, reason: 'self' },
      { type: 'room-joined', roomJid: B, nick: 'x', created: false },
    ];
    for (const e of events) expect(reduceRoom(s, e)).toBe(s);
  });

  it('adds join notices only after room-joined', () => {
    const before = run([
      joining(A),
      { type: 'occupant-joined', roomJid: A, nick: 'bob', isSelf: false },
    ]);
    expect(before.timeline).toHaveLength(0);
    expect(before.occupants).toEqual(['bob']);
    const after = run(
      [
        { type: 'room-joined', roomJid: A, nick: 'alice', created: false },
        { type: 'occupant-joined', roomJid: A, nick: 'carol', isSelf: false },
        { type: 'occupant-left', roomJid: A, nick: 'bob' },
      ],
      before,
    );
    expect(after.timeline.map((t) => (t.kind === 'notice' ? t.text : ''))).toEqual([
      'carol joined',
      'bob left',
    ]);
  });

  it('de-duplicates messages by id', () => {
    const s = run([joining(A), msg('1'), msg('1'), msg('2')]);
    expect(s.timeline).toHaveLength(2);
  });

  it('caps the timeline at 500, dropping the oldest', () => {
    const events: XmppEvent[] = [joining(A)];
    for (let i = 0; i < MAX_TIMELINE + 5; i++) events.push(msg(String(i)));
    const s = run(events);
    expect(s.timeline).toHaveLength(MAX_TIMELINE);
    const first = s.timeline[0];
    expect(first?.kind === 'message' && first.message.id).toBe('5');
  });

  it('keeps occupants sorted and unique', () => {
    const s = run([
      joining(A),
      { type: 'occupant-joined', roomJid: A, nick: 'carol', isSelf: false },
      { type: 'occupant-joined', roomJid: A, nick: 'bob', isSelf: false },
      { type: 'occupant-joined', roomJid: A, nick: 'carol', isSelf: false },
      { type: 'occupant-joined', roomJid: A, nick: 'alice', isSelf: true },
    ]);
    expect(s.occupants).toEqual(['alice', 'bob', 'carol']);
  });

  it('room-left keeps the timeline and sets leftReason', () => {
    const s = run([joining(A), msg('1'), { type: 'room-left', roomJid: A, reason: 'kicked' }]);
    expect(s.status).toBe('left');
    expect(s.leftReason).toBe('kicked');
    expect(s.timeline).toHaveLength(1);
  });

  it('message-error for the current room appends one notice', () => {
    const s1 = run([joining(A)]);
    const s2 = reduceRoom(s1, { type: 'message-error', roomJid: A, condition: 'item-not-found' });
    expect(s2.timeline).toHaveLength(1);
    const item = s2.timeline[0];
    expect(item?.kind === 'notice' && item.text).toBe(
      'Message not delivered: the room is unavailable or locked',
    );
  });

  it('message-error for another room returns the same reference', () => {
    const s1 = run([joining(A)]);
    expect(reduceRoom(s1, { type: 'message-error', roomJid: B, condition: 'forbidden' })).toBe(s1);
  });

  it('room-join-failed sets failure and keeps the timeline', () => {
    const s = run([
      joining(A),
      msg('1'),
      { type: 'room-join-failed', roomJid: A, reason: 'conflict' },
    ]);
    expect(s.status).toBe('failed');
    expect(s.failure).toEqual({ reason: 'conflict' });
    expect(s.timeline).toHaveLength(1);
  });
});

describe('reduceRoom: connection resilience', () => {
  const joinedWithNotice = (): RoomState =>
    run([
      joining(A),
      { type: 'room-joined', roomJid: A, nick: 'alice', created: false },
      { type: 'occupant-joined', roomJid: A, nick: 'bob', isSelf: false },
      msg('1'),
    ]);

  it('a terminal disconnect resets to the initial state, so a later join starts clean', () => {
    const s1 = joinedWithNotice();
    expect(s1.timeline.length).toBeGreaterThan(1);
    const s2 = reduceRoom(s1, { type: 'connection', state: { status: 'disconnected' } });
    expect(s2).toEqual(initialRoomState);
    const s3 = reduceRoom(s2, joining(A));
    expect(s3.timeline).toEqual([]);
  });

  it('a disconnect on an already-initial state returns the same reference', () => {
    const s = { ...initialRoomState };
    expect(reduceRoom(s, { type: 'connection', state: { status: 'disconnected' } })).toBe(s);
  });

  it('a nick-conflict retry keeps the timeline', () => {
    const s1 = joinedWithNotice();
    const s2 = reduceRoom(s1, joining(A, 'alice-2'));
    expect(s2.timeline).toEqual(s1.timeline);
  });

  it('other connection statuses return the same reference', () => {
    const s = joinedWithNotice();
    const states = [
      { status: 'connecting' },
      { status: 'connected', jid: 'a@b/c' },
      { status: 'reconnecting', jid: 'a@b/c', attempt: 1, nextAttemptAt: 5 },
      { status: 'disconnecting' },
    ] as const;
    for (const state of states) {
      expect(reduceRoom(s, { type: 'connection', state })).toBe(s);
    }
  });

  it('room-suspended keeps the timeline, clears occupants and sets reconnecting', () => {
    const s1 = joinedWithNotice();
    const s2 = reduceRoom(s1, { type: 'room-suspended', roomJid: A });
    expect(s2.status).toBe('reconnecting');
    expect(s2.occupants).toEqual([]);
    expect(s2.timeline).toEqual(s1.timeline);
  });

  it('room-suspended for another room returns the same reference', () => {
    const s = joinedWithNotice();
    expect(reduceRoom(s, { type: 'room-suspended', roomJid: B })).toBe(s);
  });

  it('suspended, rejoin and refilled occupants add no notices', () => {
    const s1 = joinedWithNotice();
    const s2 = run(
      [
        { type: 'room-suspended', roomJid: A },
        joining(A),
        { type: 'occupant-joined', roomJid: A, nick: 'bob', isSelf: false },
        { type: 'occupant-joined', roomJid: A, nick: 'carol', isSelf: false },
        { type: 'room-joined', roomJid: A, nick: 'alice', created: false },
      ],
      s1,
    );
    expect(s2.status).toBe('joined');
    expect(s2.timeline).toEqual(s1.timeline);
  });
});

describe('mergeHistory', () => {
  const item = (id: string): TimelineItem => ({ kind: 'message', message: hmsg(id) });
  const ids = (t: TimelineItem[]): string[] =>
    t.map((x) => (x.kind === 'message' ? x.message.id : x.id));

  it('inserts at insertAt in order and advances it', () => {
    const r = mergeHistory([item('a'), item('b')], 1, [hmsg('h1'), hmsg('h2')]);
    expect(ids(r.timeline)).toEqual(['a', 'h1', 'h2', 'b']);
    expect(r.insertAt).toBe(3);
  });

  it('de-dupes against existing ids and within the batch', () => {
    const r = mergeHistory([item('a')], 0, [hmsg('a'), hmsg('h1'), hmsg('h1'), hmsg('h2')]);
    expect(ids(r.timeline)).toEqual(['h1', 'h2', 'a']);
  });

  it('returns the same timeline reference when nothing is new', () => {
    const timeline = [item('a')];
    const r = mergeHistory(timeline, 1, [hmsg('a')]);
    expect(r.timeline).toBe(timeline);
    expect(r.insertAt).toBe(1);
    expect(mergeHistory(timeline, 1, []).timeline).toBe(timeline);
  });

  it('clamps insertAt into the timeline', () => {
    const timeline = [item('a')];
    expect(ids(mergeHistory(timeline, 99, [hmsg('h')]).timeline)).toEqual(['a', 'h']);
    expect(ids(mergeHistory(timeline, -5, [hmsg('h')]).timeline)).toEqual(['h', 'a']);
    expect(mergeHistory(timeline, 99, [hmsg('h')]).insertAt).toBe(2);
  });

  it('applies the cap by trimming the front and shifting insertAt, never below zero', () => {
    const timeline = Array.from({ length: 495 }, (_, i) => item(`t${i}`));
    const batch = Array.from({ length: 10 }, (_, i) => hmsg(`h${i}`));
    const r = mergeHistory(timeline, 495, batch);
    expect(r.timeline).toHaveLength(MAX_TIMELINE);
    expect(ids(r.timeline)[0]).toBe('t5');
    expect(ids(r.timeline).at(-1)).toBe('h9');
    expect(r.insertAt).toBe(500);
    const small = mergeHistory(timeline, 2, batch);
    expect(small.timeline).toHaveLength(MAX_TIMELINE);
    expect(small.insertAt).toBe(7);
    const huge = Array.from({ length: 600 }, (_, i) => hmsg(`x${i}`));
    expect(mergeHistory([], 0, huge).insertAt).toBe(500);
    expect(mergeHistory(timeline, 0, huge).insertAt).toBeGreaterThanOrEqual(0);
  });
});

describe('reduceRoom history', () => {
  const joinedEvt = (nick = 'alice'): XmppEvent => ({
    type: 'room-joined',
    roomJid: A,
    nick,
    created: false,
  });
  const loading = (direction: 'initial' | 'gap' = 'initial'): XmppEvent => ({
    type: 'history-loading',
    roomJid: A,
    direction,
  });
  const loadedEvt = (
    messages: ChatMessage[],
    over: Partial<Extract<XmppEvent, { type: 'history-loaded' }>> = {},
  ): XmppEvent => ({
    type: 'history-loaded',
    roomJid: A,
    direction: 'initial',
    messages,
    done: true,
    complete: true,
    ...over,
  });
  const ids = (s: RoomState): string[] =>
    s.timeline.map((t) => (t.kind === 'message' ? t.message.id : `notice:${t.text}`));

  it('starts idle', () => {
    expect(initialRoomState.history).toEqual({
      loading: false,
      failed: false,
      canLoadEarlier: false,
      insertAt: 0,
    });
  });

  it('room-joined sets insertAt to the timeline length', () => {
    const s = run([joining(A), msg('1'), msg('2'), joinedEvt()]);
    expect(s.history.insertAt).toBe(2);
  });

  it('history lands before everything received live after the join, whatever the clocks say', () => {
    const live = (id: string, sentAt: number): XmppEvent => {
      const e = msg(id);
      return e.type === 'message' ? { type: 'message', message: { ...e.message, sentAt } } : e;
    };
    const s = run([
      joining(A),
      joinedEvt(),
      loading(),
      // A live message that is older by the phone's clock than the history stamps below.
      live('L1', 100),
      loadedEvt([hmsg('H1', 5_000), hmsg('H2', 6_000)]),
    ]);
    expect(ids(s)).toEqual(['H1', 'H2', 'L1']);
  });

  it('a retried initial load still lands above live messages received after the join', () => {
    const s = run([
      joining(A),
      joinedEvt(),
      loading(),
      msg('L1'),
      { type: 'history-failed', roomJid: A, direction: 'initial', condition: 'timeout' },
      msg('L2'),
      loading(),
      loadedEvt([hmsg('H1'), hmsg('H2')]),
    ]);
    expect(ids(s)).toEqual(['H1', 'H2', 'L1', 'L2']);
  });

  it('gap history lands after the pre-outage messages and before post-rejoin live messages', () => {
    const s = run([
      joining(A),
      joinedEvt(),
      msg('old1'),
      msg('old2'),
      { type: 'room-suspended', roomJid: A },
      joining(A),
      joinedEvt(),
      loading('gap'),
      msg('new1'),
      loadedEvt([hmsg('G1'), hmsg('G2')], { direction: 'gap' }),
    ]);
    expect(ids(s)).toEqual(['old1', 'old2', 'G1', 'G2', 'new1']);
  });

  it('ignores a live message whose id already arrived via history', () => {
    const s = run([joining(A), joinedEvt(), loadedEvt([hmsg('S1')]), msg('S1')]);
    expect(ids(s)).toEqual(['S1']);
  });

  it('shifts insertAt when live appends are trimmed by the cap', () => {
    let s = run([joining(A), joinedEvt()]);
    s = run(
      Array.from({ length: MAX_TIMELINE }, (_, i) => msg(`a${i}`)),
      s,
    );
    expect(s.history.insertAt).toBe(0);
    s = run([joinedEvt()], s);
    expect(s.history.insertAt).toBe(MAX_TIMELINE);
    s = run([msg('b0'), msg('b1'), msg('b2')], s);
    expect(s.timeline).toHaveLength(MAX_TIMELINE);
    expect(s.history.insertAt).toBe(MAX_TIMELINE - 3);
  });

  it('tracks loading and failed flags', () => {
    let s = run([joining(A), joinedEvt(), loading()]);
    expect(s.history).toMatchObject({ loading: true, failed: false });
    s = reduceRoom(s, { type: 'history-failed', roomJid: A, direction: 'initial', condition: 'x' });
    expect(s.history).toMatchObject({ loading: false, failed: true });
    s = reduceRoom(s, loading());
    expect(s.history).toMatchObject({ loading: true, failed: false });
    s = reduceRoom(s, loadedEvt([]));
    expect(s.history).toMatchObject({ loading: false, failed: false });
  });

  it('room-suspended clears loading but keeps the history', () => {
    const s = run([joining(A), joinedEvt(), loadedEvt([hmsg('H1')]), loading('gap')]);
    const t = reduceRoom(s, { type: 'room-suspended', roomJid: A });
    expect(t.history.loading).toBe(false);
    expect(ids(t)).toEqual(['H1']);
  });

  it('a rejoin of the same room keeps history, a new room resets it', () => {
    const s = run([joining(A), joinedEvt(), loadedEvt([hmsg('H1')], { complete: false })]);
    expect(s.history.canLoadEarlier).toBe(true);
    expect(reduceRoom(s, joining(A)).history.canLoadEarlier).toBe(true);
    expect(reduceRoom(s, joining(B)).history).toEqual(initialRoomState.history);
  });

  it('initial done sets canLoadEarlier from complete', () => {
    const base = run([joining(A), joinedEvt(), loading()]);
    expect(reduceRoom(base, loadedEvt([hmsg('H1')], { complete: true })).history.canLoadEarlier).toBe(
      false,
    );
    expect(reduceRoom(base, loadedEvt([hmsg('H1')], { complete: false })).history.canLoadEarlier).toBe(
      true,
    );
  });

  it('an incomplete gap done inserts the notice once, at insertAt', () => {
    let s = run([joining(A), joinedEvt(), msg('old'), joinedEvt(), loading('gap')]);
    s = reduceRoom(
      s,
      loadedEvt([hmsg('G1')], { direction: 'gap', done: false, complete: false }),
    );
    expect(s.history.loading).toBe(true);
    expect(ids(s).filter((x) => x.startsWith('notice:'))).toEqual([]);
    s = reduceRoom(
      s,
      loadedEvt([hmsg('G2')], { direction: 'gap', done: true, complete: false }),
    );
    expect(ids(s)).toEqual(['old', 'G1', 'G2', `notice:${HISTORY_TEXT.gapTruncated}`]);
    expect(s.history.insertAt).toBe(4);
    expect(s.history.loading).toBe(false);
  });

  it('a complete gap adds no notice', () => {
    const s = run([
      joining(A),
      joinedEvt(),
      loadedEvt([hmsg('G1')], { direction: 'gap', done: true, complete: true }),
    ]);
    expect(ids(s)).toEqual(['G1']);
  });

  it('history events for another room return the same reference', () => {
    const s = run([joining(A), joinedEvt()]);
    const events: XmppEvent[] = [
      { type: 'history-loading', roomJid: B, direction: 'initial' },
      { ...(loadedEvt([hmsg('H1', 1, B)]) as object), roomJid: B } as XmppEvent,
      { type: 'history-failed', roomJid: B, direction: 'initial', condition: 'x' },
    ];
    for (const e of events) expect(reduceRoom(s, e)).toBe(s);
  });

  it('a history-loaded with nothing new and no flag change returns the same reference', () => {
    const s = run([joining(A), joinedEvt(), loadedEvt([hmsg('H1')])]);
    expect(reduceRoom(s, loadedEvt([hmsg('H1')]))).toBe(s);
    expect(reduceRoom(s, loadedEvt([]))).toBe(s);
  });

  it('a terminal disconnect resets the history', () => {
    const s = run([joining(A), joinedEvt(), loading(), loadedEvt([hmsg('H1')], { complete: false })]);
    const t = reduceRoom(s, { type: 'connection', state: { status: 'disconnected' } });
    expect(t).toEqual(initialRoomState);
    expect(t.history.canLoadEarlier).toBe(false);
  });
});
