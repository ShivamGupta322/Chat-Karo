import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXmppClient } from '../../src/xmpp/client';
import type { XmppClient, XmppEvent } from '../../src/xmpp/types';
import { createFakeTransport, type FakeTransport } from '../helpers/fakeTransport';
import {
  CAPTURED_ROOM,
  CAPTURED_SELF_201,
  ROOM,
  groupchat,
  parse,
  presence,
  presenceError,
} from '../fixtures/stanzas';
import { installPageHideClose } from '../../src/xmpp/pageHide';

const MUC = 'muc.chaterl.localhost';
const ROOM2 = `test1@${MUC}`;
const PASSWORD = 'hunter2-secret';

interface Ctx {
  t: FakeTransport;
  client: XmppClient;
  events: XmppEvent[];
}

function setup(): Ctx {
  const t = createFakeTransport();
  let n = 0;
  const client = createXmppClient(t, {
    mucDomain: MUC,
    newId: () => `id${++n}`,
    now: () => 1_000,
  });
  const events: XmppEvent[] = [];
  client.subscribe((e) => events.push(e));
  return { t, client, events };
}

function connect({ t, client }: Ctx): void {
  client.connect('alice@chaterl.localhost', PASSWORD);
  t.pushStatus({ kind: 'connecting' });
  t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
}

function joined(ctx: Ctx, room = ROOM, nick = 'alice'): void {
  ctx.client.joinRoom(room, nick);
  ctx.t.pushStanza(
    parse(
      `<presence from="${room}/${nick}"><x xmlns="http://jabber.org/protocol/muc#user"><status code="110"/></x></presence>`,
    ),
  );
}

const types = (events: XmppEvent[]): string[] => events.map((e) => e.type);
const joinPresences = (t: FakeTransport): string[] =>
  t.sent
    .filter((e) => e.localName === 'presence' && e.getAttribute('type') === null && e.hasAttribute('to'))
    .map((e) => e.getAttribute('to') ?? '');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connection', () => {
  it('emits connecting then connected and sends initial presence', () => {
    const ctx = setup();
    connect(ctx);
    const states = ctx.events.flatMap((e) => (e.type === 'connection' ? [e.state.status] : []));
    expect(states).toEqual(['connecting', 'connected']);
    expect(ctx.t.sentNames()).toEqual(['presence']);
    expect(ctx.t.sent[0]?.hasAttribute('to')).toBe(false);
  });

  it('auth failure then disconnected ends disconnected with the error, emitted once', () => {
    const ctx = setup();
    ctx.client.connect('alice@chaterl.localhost', 'bad');
    ctx.t.pushStatus({ kind: 'connecting' });
    ctx.t.pushStatus({ kind: 'failed', reason: 'auth-failed' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    const finals = ctx.events.filter(
      (e) => e.type === 'connection' && e.state.status === 'disconnected',
    );
    expect(finals).toHaveLength(1);
    expect(ctx.client.getState()).toEqual({
      status: 'disconnected',
      error: { reason: 'auth-failed' },
    });
  });

  it('connect while connecting or connected is a no-op', () => {
    const ctx = setup();
    ctx.client.connect('alice@chaterl.localhost', 'pw');
    ctx.client.connect('alice@chaterl.localhost', 'pw');
    expect(ctx.t.connectCalls).toHaveLength(1);
    ctx.t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    ctx.client.connect('alice@chaterl.localhost', 'pw');
    expect(ctx.t.connectCalls).toHaveLength(1);
  });

  it('disconnect goes disconnecting then disconnected without error', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    expect(ctx.client.getState().status).toBe('disconnecting');
    expect(ctx.t.disconnectCalls).toEqual(['user']);
    ctx.t.pushStatus({ kind: 'disconnecting' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual({ status: 'disconnected' });
  });

  it('never keeps the password in state or events', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    expect(JSON.stringify(ctx.client.getState())).not.toContain(PASSWORD);
    expect(JSON.stringify(ctx.events)).not.toContain(PASSWORD);
    expect(ctx.t.connectCalls[0]?.password).toBe(PASSWORD);
  });

  it('can reconnect after a disconnect', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: 'disconnected' });
    ctx.client.connect('alice@chaterl.localhost', 'pw');
    expect(ctx.t.connectCalls).toHaveLength(2);
  });
});

describe('connection loss semantics', () => {
  const lost = { status: 'disconnected', error: { reason: 'connection-lost' } };

  it('an unexpected transport disconnect reports connection-lost', () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual(lost);
  });

  it('a transport-initiated disconnecting then disconnected is still a loss', () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStatus({ kind: 'disconnecting' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual(lost);
  });

  it('a user disconnect has no error', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: 'disconnecting' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual({ status: 'disconnected' });
  });

  it('a pagehide-triggered disconnect has no error', () => {
    const ctx = setup();
    connect(ctx);
    const target = new EventTarget();
    installPageHideClose(ctx.client, target);
    target.dispatchEvent(new Event('pagehide'));
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual({ status: 'disconnected' });
  });

  it('auth failure then disconnected still reports auth-failed', () => {
    const ctx = setup();
    ctx.client.connect('alice@chaterl.localhost', 'bad');
    ctx.t.pushStatus({ kind: 'connecting' });
    ctx.t.pushStatus({ kind: 'failed', reason: 'auth-failed' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual({
      status: 'disconnected',
      error: { reason: 'auth-failed' },
    });
  });

  it('the user-initiated flag is cleared by the next connect', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.disconnect();
    ctx.t.pushStatus({ kind: 'disconnected' });
    connect(ctx);
    ctx.t.pushStatus({ kind: 'disconnected' });
    expect(ctx.client.getState()).toEqual(lost);
  });
});

describe('joining', () => {
  it('happy path: occupants then room-joined created=false', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('bob'));
    ctx.t.pushStanza(presence('carol'));
    ctx.t.pushStanza(presence('alice', ['110']));
    const roomEvents = ctx.events.filter((e) => e.type !== 'connection');
    expect(roomEvents).toEqual([
      { type: 'room-joining', roomJid: ROOM, nick: 'alice' },
      { type: 'occupant-joined', roomJid: ROOM, nick: 'bob', isSelf: false },
      { type: 'occupant-joined', roomJid: ROOM, nick: 'carol', isSelf: false },
      { type: 'occupant-joined', roomJid: ROOM, nick: 'alice', isSelf: true },
      { type: 'room-joined', roomJid: ROOM, nick: 'alice', created: false },
    ]);
    const hist = ctx.t.sent[1]?.querySelector('history');
    expect(hist?.getAttribute('maxstanzas')).toBe('20');
  });

  it('a duplicate join sends one presence', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.client.joinRoom(ROOM, 'alice');
    expect(joinPresences(ctx.t)).toHaveLength(1);
  });

  it('reports invalid room, invalid nick and not-connected without sending', () => {
    const ctx = setup();
    ctx.client.joinRoom(ROOM, 'alice');
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'not-connected' });
    connect(ctx);
    const before = ctx.t.sent.length;
    ctx.client.joinRoom('Bad Room@x', 'alice');
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'invalid-room' });
    ctx.client.joinRoom(ROOM, '   ');
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'invalid-nick' });
    expect(ctx.t.sent).toHaveLength(before);
  });

  it('201 sends the instant-config IQ and reports created=true on success', async () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('alice', ['110', '201']));
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.t.iqs[0]?.getAttribute('to')).toBe(ROOM);
    ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.events.at(-1)).toEqual({
      type: 'room-joined',
      roomJid: ROOM,
      nick: 'alice',
      created: true,
    });
  });

  it('real MongooseIM 201 frame sends one owner IQ; room-joined only after the result', async () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(CAPTURED_ROOM, 'alice');
    ctx.t.pushStanza(CAPTURED_SELF_201);
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.t.iqs[0]?.querySelector('query')?.namespaceURI).toBe(
      'http://jabber.org/protocol/muc#owner',
    );
    expect(types(ctx.events)).not.toContain('room-joined');
    ctx.t.resolveIq(0, { ok: true, stanza: parse('<iq type="result"/>') });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.t.iqs).toHaveLength(1);
    expect(ctx.events.at(-1)).toEqual({
      type: 'room-joined',
      roomJid: CAPTURED_ROOM,
      nick: 'alice',
      created: true,
    });
  });

  it('fails immediately when the room sends self unavailable while joining', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('alice', ['110'], 'unavailable'));
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'other' });
  });

  it.each([
    ['error', { ok: false as const, condition: 'forbidden' }],
    ['timeout', { ok: false as const, condition: 'timeout' }],
  ])('201 with IQ %s leaves and reports room-config-failed', async (_n, result) => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('alice', ['110', '201']));
    ctx.t.resolveIq(0, result);
    await vi.advanceTimersByTimeAsync(0);
    const last = ctx.t.sent.at(-1);
    expect(last?.getAttribute('type')).toBe('unavailable');
    expect(ctx.events.at(-1)).toEqual({
      type: 'room-join-failed',
      roomJid: ROOM,
      reason: 'room-config-failed',
      condition: result.condition,
    });
  });

  it('retries a nick conflict as alice-2, alice-3, alice-4 then fails', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    for (let i = 0; i < 4; i++) ctx.t.pushStanza(presenceError('conflict'));
    expect(joinPresences(ctx.t)).toEqual([
      `${ROOM}/alice`,
      `${ROOM}/alice-2`,
      `${ROOM}/alice-3`,
      `${ROOM}/alice-4`,
    ]);
    expect(ctx.events.at(-1)).toEqual({
      type: 'room-join-failed',
      roomJid: ROOM,
      reason: 'conflict',
    });
    const joining = ctx.events.filter((e) => e.type === 'room-joining');
    expect(joining).toHaveLength(4);
  });

  it('joins with the server-assigned nick from the 110 presence', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('alice-1', ['110', '210']));
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-joined', nick: 'alice-1' });
  });

  it('does not retry forbidden', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presenceError('forbidden'));
    expect(joinPresences(ctx.t)).toHaveLength(1);
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'forbidden' });
  });

  it('maps unknown error conditions to other with the condition', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presenceError('resource-constraint'));
    expect(ctx.events.at(-1)).toEqual({
      type: 'room-join-failed',
      roomJid: ROOM,
      reason: 'other',
      condition: 'resource-constraint',
    });
  });

  it('times out after 10 s, leaves, and ignores a late self presence', () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    vi.advanceTimersByTime(10_000);
    expect(ctx.t.sent.at(-1)?.getAttribute('type')).toBe('unavailable');
    expect(ctx.events.at(-1)).toMatchObject({ type: 'room-join-failed', reason: 'timeout' });
    const count = ctx.events.length;
    ctx.t.pushStanza(presence('alice', ['110']));
    expect(ctx.events).toHaveLength(count);
  });
});

describe('occupants and leaving', () => {
  it("emits occupant-left for another user's unavailable", () => {
    const ctx = setup();
    connect(ctx);
    ctx.client.joinRoom(ROOM, 'alice');
    ctx.t.pushStanza(presence('bob'));
    ctx.t.pushStanza(presence('alice', ['110']));
    ctx.t.pushStanza(presence('bob', [], 'unavailable'));
    expect(ctx.events.at(-1)).toEqual({ type: 'occupant-left', roomJid: ROOM, nick: 'bob' });
  });

  it('self 307 emits room-left kicked', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(presence('alice', ['110', '307'], 'unavailable'));
    expect(ctx.events.at(-1)).toEqual({ type: 'room-left', roomJid: ROOM, reason: 'kicked' });
  });

  it('leaveRoom sends unavailable, emits room-left self, then ignores the room', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.client.leaveRoom(ROOM);
    expect(ctx.t.sent.at(-1)?.getAttribute('type')).toBe('unavailable');
    expect(ctx.events.at(-1)).toEqual({ type: 'room-left', roomJid: ROOM, reason: 'self' });
    const count = ctx.events.length;
    ctx.t.pushStanza(presence('alice', ['110'], 'unavailable'));
    ctx.t.pushStanza(presence('bob'));
    ctx.t.pushStanza(groupchat('bob', 'hello'));
    expect(ctx.events).toHaveLength(count);
  });

  it('a transport drop leaves every room and ends disconnected with the error', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    joined(ctx, ROOM2);
    ctx.t.pushStatus({ kind: 'failed', reason: 'connection-failed', condition: 'x' });
    ctx.t.pushStatus({ kind: 'disconnected' });
    const left = ctx.events.filter((e) => e.type === 'room-left');
    expect(left).toEqual([
      { type: 'room-left', roomJid: ROOM, reason: 'disconnected' },
      { type: 'room-left', roomJid: ROOM2, reason: 'disconnected' },
    ]);
    expect(ctx.client.getState()).toEqual({
      status: 'disconnected',
      error: { reason: 'connection-failed', condition: 'x' },
    });
  });
});

describe('messages', () => {
  it('flags the echo of our own message as own', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(groupchat('alice', 'hi'));
    ctx.t.pushStanza(groupchat('bob', 'yo', '', 'm2'));
    const msgs = ctx.events.flatMap((e) => (e.type === 'message' ? [e.message] : []));
    expect(msgs.map((m) => m.isOwn)).toEqual([true, false]);
    expect(msgs[0]).toMatchObject({ body: 'hi', sentAt: 1_000, isHistory: false });
  });

  it('marks delayed messages as history', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(
      groupchat('bob', 'old', '<delay xmlns="urn:xmpp:delay" stamp="2024-01-02T03:04:05Z"/>'),
    );
    const m = ctx.events.at(-1);
    expect(m).toMatchObject({ type: 'message', message: { isHistory: true } });
  });

  it('ignores messages from untracked rooms', () => {
    const ctx = setup();
    connect(ctx);
    const count = ctx.events.length;
    ctx.t.pushStanza(groupchat('bob', 'hello'));
    expect(ctx.events).toHaveLength(count);
  });

  it('reports message errors', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    ctx.t.pushStanza(
      parse(
        `<message from="${ROOM}" type="error"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></message>`,
      ),
    );
    expect(ctx.events.at(-1)).toEqual({
      type: 'message-error',
      roomJid: ROOM,
      condition: 'forbidden',
    });
  });
});

describe('sendGroupchat', () => {
  it('rejects empty, too-long, not-connected and not-joined without sending', () => {
    const ctx = setup();
    expect(ctx.client.sendGroupchat(ROOM, 'hi')).toEqual({ ok: false, error: 'not-connected' });
    connect(ctx);
    const before = ctx.t.sent.length;
    expect(ctx.client.sendGroupchat(ROOM, '   ')).toEqual({ ok: false, error: 'empty' });
    expect(ctx.client.sendGroupchat(ROOM, 'hi')).toEqual({ ok: false, error: 'not-joined' });
    joined(ctx);
    const afterJoin = ctx.t.sent.length;
    expect(ctx.client.sendGroupchat(ROOM, '😀'.repeat(2001))).toEqual({
      ok: false,
      error: 'too-long',
    });
    expect(ctx.t.sent).toHaveLength(afterJoin);
    expect(afterJoin).toBeGreaterThan(before);
  });

  it('accepts exactly 2000 code points', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    expect(ctx.client.sendGroupchat(ROOM, '😀'.repeat(2000)).ok).toBe(true);
  });

  it('sends the trimmed body with the generated id', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    const res = ctx.client.sendGroupchat(ROOM, '  hello  ');
    expect(res).toEqual({ ok: true, id: 'id1' });
    const sent = ctx.t.sent.at(-1);
    expect(sent?.getAttribute('type')).toBe('groupchat');
    expect(sent?.getAttribute('id')).toBe('id1');
    expect(sent?.querySelector('body')?.textContent).toBe('hello');
  });

  it('does not render optimistically', () => {
    const ctx = setup();
    connect(ctx);
    joined(ctx);
    const count = ctx.events.length;
    ctx.client.sendGroupchat(ROOM, 'hello');
    expect(ctx.events).toHaveLength(count);
  });
});

describe('misc', () => {
  it('answers incoming iq get with service-unavailable and the same id', () => {
    const ctx = setup();
    connect(ctx);
    ctx.t.pushStanza(
      parse(
        '<iq from="chaterl.localhost" type="get" id="p1"><ping xmlns="urn:xmpp:ping"/></iq>',
      ),
    );
    const reply = ctx.t.sent.at(-1);
    expect(reply?.localName).toBe('iq');
    expect(reply?.getAttribute('id')).toBe('p1');
    expect(reply?.getAttribute('type')).toBe('error');
    expect(reply?.querySelector('service-unavailable')).not.toBeNull();
  });

  it('does not reply to result iqs', () => {
    const ctx = setup();
    connect(ctx);
    const before = ctx.t.sent.length;
    ctx.t.pushStanza(parse('<iq type="result" id="r1"/>'));
    expect(ctx.t.sent).toHaveLength(before);
  });

  it('isolates a throwing subscriber', () => {
    const ctx = setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx.client.subscribe(() => {
      throw new Error('boom');
    });
    const seen: string[] = [];
    ctx.client.subscribe((e) => seen.push(e.type));
    connect(ctx);
    expect(seen).toContain('connection');
    expect(types(ctx.events)).toContain('connection');
    spy.mockRestore();
  });

  it('unsubscribe stops delivery', () => {
    const ctx = setup();
    const seen: string[] = [];
    const off = ctx.client.subscribe((e) => seen.push(e.type));
    off();
    connect(ctx);
    expect(seen).toEqual([]);
  });
});
