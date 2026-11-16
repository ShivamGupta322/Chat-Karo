import { describe, expect, it } from 'vitest';
import {
  MAX_TIMELINE,
  initialRoomState,
  reduceRoom,
  type RoomState,
} from '../../src/state/room';
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
