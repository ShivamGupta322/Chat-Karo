import { isValidRoomJid, normalizeNick } from './jid';
import { acceptInstantRoom } from './roomCreation';
import {
  buildGroupchat,
  buildIqErrorReply,
  buildJoinPresence,
  buildLeavePresence,
  buildPresence,
  parseErrorCondition,
  parseGroupchat,
  parseMucPresence,
  type MucPresence,
} from './stanzas';
import type { TransportStatus, XmppTransport } from './transport';
import {
  MAX_MESSAGE_LENGTH,
  type ConnectionError,
  type ConnectionState,
  type JoinFailure,
  type LeaveReason,
  type SendResult,
  type XmppClient,
  type XmppClientOptions,
  type XmppEvent,
} from './types';

interface TrackedRoom {
  roomJid: string;
  state: 'joining' | 'joined';
  baseNick: string;
  nick: string;
  attempt: number;
  configuring: boolean;
  occupants: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const KNOWN_FAILURES: ReadonlySet<string> = new Set<JoinFailure>([
  'conflict',
  'not-authorized',
  'forbidden',
  'registration-required',
  'service-unavailable',
  'not-acceptable',
  'item-not-found',
]);

function sameState(a: ConnectionState, b: ConnectionState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'connected' && b.status === 'connected') return a.jid === b.jid;
  if (a.status === 'disconnected' && b.status === 'disconnected') {
    return a.error?.reason === b.error?.reason && a.error?.condition === b.error?.condition;
  }
  return true;
}

export function createXmppClient(
  transport: XmppTransport,
  options: XmppClientOptions,
): XmppClient {
  const joinTimeoutMs = options.joinTimeoutMs ?? 10_000;
  const iqTimeoutMs = options.iqTimeoutMs ?? 10_000;
  const maxNickRetries = options.maxNickRetries ?? 3;
  const historyMaxStanzas = options.historyMaxStanzas ?? 20;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());

  let state: ConnectionState = { status: 'idle' };
  let generation = 0;
  // Set only by our own disconnect(); the transport's own 'disconnecting' status must not set it.
  let userInitiated = false;
  const rooms = new Map<string, TrackedRoom>();
  const listeners = new Set<(e: XmppEvent) => void>();

  function emit(event: XmppEvent): void {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error('xmpp listener error', err instanceof Error ? err.name : 'unknown');
      }
    }
  }

  function setState(next: ConnectionState): void {
    if (sameState(state, next)) return;
    state = next;
    emit({ type: 'connection', state });
  }

  function clearTimer(room: TrackedRoom): void {
    if (room.timer !== null) {
      clearTimeout(room.timer);
      room.timer = null;
    }
  }

  function untrack(room: TrackedRoom): void {
    clearTimer(room);
    if (rooms.get(room.roomJid) === room) rooms.delete(room.roomJid);
  }

  function startJoinTimer(room: TrackedRoom): void {
    clearTimer(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      if (rooms.get(room.roomJid) !== room || room.state !== 'joining') return;
      transport.send(buildLeavePresence(room.roomJid, room.nick));
      untrack(room);
      emit({ type: 'room-join-failed', roomJid: room.roomJid, reason: 'timeout' });
    }, joinTimeoutMs);
  }

  function sendJoin(room: TrackedRoom): void {
    transport.send(buildJoinPresence(room.roomJid, room.nick, historyMaxStanzas));
    emit({ type: 'room-joining', roomJid: room.roomJid, nick: room.nick });
    startJoinTimer(room);
  }

  function onTransportStatus(status: TransportStatus, myGeneration: number): void {
    if (myGeneration !== generation) return;
    switch (status.kind) {
      case 'connecting':
        setState({ status: 'connecting' });
        break;
      case 'connected':
        setState({ status: 'connected', jid: status.jid });
        transport.send(buildPresence());
        break;
      case 'disconnecting':
        if (state.status === 'connecting' || state.status === 'connected') {
          setState({ status: 'disconnecting' });
        }
        break;
      case 'failed': {
        const error: ConnectionError =
          status.condition !== undefined
            ? { reason: status.reason, condition: status.condition }
            : { reason: status.reason };
        finishDisconnect(error);
        break;
      }
      case 'disconnected':
        // An unexpected close (no failed status, not requested by us) is a lost connection.
        finishDisconnect(
          !userInitiated && (state.status === 'connected' || state.status === 'disconnecting')
            ? { reason: 'connection-lost' }
            : undefined,
        );
        break;
    }
  }

  // Strophe reports failed and then disconnected; the first one wins so the error survives.
  function finishDisconnect(error: ConnectionError | undefined): void {
    if (state.status === 'disconnected' || state.status === 'idle') return;
    for (const room of [...rooms.values()]) {
      clearTimer(room);
      emit({ type: 'room-left', roomJid: room.roomJid, reason: 'disconnected' });
    }
    rooms.clear();
    setState(error ? { status: 'disconnected', error } : { status: 'disconnected' });
  }

  function failJoin(room: TrackedRoom, reason: JoinFailure, condition?: string): void {
    untrack(room);
    emit(
      condition !== undefined
        ? { type: 'room-join-failed', roomJid: room.roomJid, reason, condition }
        : { type: 'room-join-failed', roomJid: room.roomJid, reason },
    );
  }

  function handleJoiningPresence(room: TrackedRoom, p: MucPresence): void {
    if (p.kind === 'error') {
      const cond = p.errorCondition ?? 'undefined-condition';
      if (cond === 'conflict' && room.attempt < maxNickRetries) {
        room.nick = `${room.baseNick}-${room.attempt + 2}`;
        room.attempt += 1;
        sendJoin(room);
        return;
      }
      if (KNOWN_FAILURES.has(cond)) failJoin(room, cond as JoinFailure);
      else failJoin(room, 'other', cond);
      return;
    }
    const isSelf = p.statusCodes.has('110') || p.nick === room.nick;
    if (p.kind === 'available' && !isSelf) {
      if (!room.occupants.has(p.nick)) {
        room.occupants.add(p.nick);
        emit({ type: 'occupant-joined', roomJid: room.roomJid, nick: p.nick, isSelf: false });
      }
      return;
    }
    if (p.kind === 'unavailable' && isSelf && !room.configuring) {
      // e.g. the room was destroyed mid-join; fail now instead of waiting for the join timer.
      failJoin(room, 'other', 'unavailable');
      return;
    }
    if (p.kind !== 'available' || room.configuring) return;
    // The server's resource is the real nick (handles status 210).
    room.nick = p.nick;
    if (!p.statusCodes.has('201')) {
      markJoined(room, false);
      return;
    }
    room.configuring = true;
    clearTimer(room);
    // TEMPORARY (Phase 3): the single call site of room creation.
    void acceptInstantRoom(transport, room.roomJid, iqTimeoutMs).then((res) => {
      if (rooms.get(room.roomJid) !== room) return;
      if (res.ok) {
        markJoined(room, true);
      } else {
        transport.send(buildLeavePresence(room.roomJid, room.nick));
        failJoin(room, 'room-config-failed', res.condition);
      }
    });
  }

  function markJoined(room: TrackedRoom, created: boolean): void {
    clearTimer(room);
    room.state = 'joined';
    room.configuring = false;
    room.occupants.add(room.nick);
    emit({ type: 'occupant-joined', roomJid: room.roomJid, nick: room.nick, isSelf: true });
    emit({ type: 'room-joined', roomJid: room.roomJid, nick: room.nick, created });
  }

  function handleJoinedPresence(room: TrackedRoom, p: MucPresence): void {
    if (p.kind === 'error') return;
    const isSelf = p.statusCodes.has('110') || p.nick === room.nick;
    if (p.kind === 'available') {
      if (!isSelf && !room.occupants.has(p.nick)) {
        room.occupants.add(p.nick);
        emit({ type: 'occupant-joined', roomJid: room.roomJid, nick: p.nick, isSelf: false });
      }
      return;
    }
    if (!isSelf) {
      if (room.occupants.delete(p.nick)) {
        emit({ type: 'occupant-left', roomJid: room.roomJid, nick: p.nick });
      }
      return;
    }
    const reason: LeaveReason = p.statusCodes.has('307')
      ? 'kicked'
      : p.statusCodes.has('301')
        ? 'banned'
        : 'other';
    untrack(room);
    emit({ type: 'room-left', roomJid: room.roomJid, reason });
  }

  function handlePresence(el: Element): void {
    const p = parseMucPresence(el);
    if (!p) return;
    const room = rooms.get(p.roomJid);
    if (!room) return;
    if (room.state === 'joining') handleJoiningPresence(room, p);
    else handleJoinedPresence(room, p);
  }

  function handleMessage(el: Element): void {
    const type = el.getAttribute('type');
    const from = el.getAttribute('from') ?? '';
    const slash = from.indexOf('/');
    const bare = slash < 0 ? from : from.slice(0, slash);
    const room = rooms.get(bare);
    if (!room) return;
    if (type === 'error') {
      emit({ type: 'message-error', roomJid: room.roomJid, condition: parseErrorCondition(el) });
      return;
    }
    const m = parseGroupchat(el);
    if (!m) return;
    const sentAt = m.delayedAt ?? now();
    emit({
      type: 'message',
      message: {
        id:
          m.stanzaId ??
          m.id ??
          `${room.roomJid}|${sentAt}|${m.nick ?? ''}|${m.body.length}`,
        roomJid: room.roomJid,
        nick: m.nick,
        body: m.body,
        sentAt,
        isHistory: m.delayedAt !== null,
        isOwn: m.nick !== null && m.nick === room.nick,
      },
    });
  }

  function onStanza(el: Element): void {
    switch (el.localName) {
      case 'presence':
        handlePresence(el);
        break;
      case 'message':
        handleMessage(el);
        break;
      case 'iq': {
        const type = el.getAttribute('type');
        if (type === 'get' || type === 'set') transport.send(buildIqErrorReply(el));
        break;
      }
    }
  }

  transport.onStanza(onStanza);

  return {
    getState: () => state,

    connect(jid, password) {
      if (state.status !== 'idle' && state.status !== 'disconnected') return;
      const myGeneration = ++generation;
      userInitiated = false;
      setState({ status: 'connecting' });
      // The password is handed to the transport and deliberately not kept here.
      transport.connect(jid, password, (s) => {
        onTransportStatus(s, myGeneration);
      });
    },

    disconnect() {
      if (state.status !== 'connecting' && state.status !== 'connected') return;
      userInitiated = true;
      setState({ status: 'disconnecting' });
      transport.disconnect('user');
    },

    joinRoom(roomJid, nick) {
      if (state.status !== 'connected') {
        emit({ type: 'room-join-failed', roomJid, reason: 'not-connected' });
        return;
      }
      if (!isValidRoomJid(roomJid, options.mucDomain)) {
        emit({ type: 'room-join-failed', roomJid, reason: 'invalid-room' });
        return;
      }
      const baseNick = normalizeNick(nick);
      if (baseNick === null) {
        emit({ type: 'room-join-failed', roomJid, reason: 'invalid-nick' });
        return;
      }
      if (rooms.has(roomJid)) return;
      const room: TrackedRoom = {
        roomJid,
        state: 'joining',
        baseNick,
        nick: baseNick,
        attempt: 0,
        configuring: false,
        occupants: new Set(),
        timer: null,
      };
      rooms.set(roomJid, room);
      sendJoin(room);
    },

    leaveRoom(roomJid) {
      const room = rooms.get(roomJid);
      if (!room) return;
      transport.send(buildLeavePresence(room.roomJid, room.nick));
      untrack(room);
      emit({ type: 'room-left', roomJid, reason: 'self' });
    },

    sendGroupchat(roomJid, body): SendResult {
      const text = body.trim();
      if (text === '') return { ok: false, error: 'empty' };
      if ([...text].length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'too-long' };
      if (state.status !== 'connected') return { ok: false, error: 'not-connected' };
      const room = rooms.get(roomJid);
      if (!room || room.state !== 'joined') return { ok: false, error: 'not-joined' };
      const id = newId();
      transport.send(buildGroupchat(roomJid, text, id));
      return { ok: true, id };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
