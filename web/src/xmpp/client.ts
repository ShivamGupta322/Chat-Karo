import { domainOf, isValidRoomJid, normalizeNick } from './jid';
import { DEFAULT_BACKOFF, createRetryScheduler } from './reconnect';
import { acceptInstantRoom } from './roomCreation';
import {
  buildGroupchat,
  buildIqErrorReply,
  buildIqResult,
  buildJoinPresence,
  buildLeavePresence,
  buildPing,
  buildPresence,
  isPingRequest,
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
  state: 'joining' | 'joined' | 'suspended';
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
  if (a.status === 'reconnecting' && b.status === 'reconnecting') {
    return a.jid === b.jid && a.attempt === b.attempt && a.nextAttemptAt === b.nextAttemptAt;
  }
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
  const stableAfterMs = options.stableAfterMs ?? 60_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const wakeMinIntervalMs = options.wakeMinIntervalMs ?? 5_000;
  const probeMinIntervalMs = options.probeMinIntervalMs ?? 30_000;
  const scheduler = createRetryScheduler({
    policy: { ...DEFAULT_BACKOFF, ...options.backoff },
    random: options.random ?? Math.random,
    now,
  });

  let state: ConnectionState = { status: 'idle' };
  let generation = 0;
  // Set only by our own disconnect(); the transport's own 'disconnecting' status must not set it.
  let userInitiated = false;
  // In memory only, so a dropped session can be retried. Never persisted, logged or emitted.
  let creds: { jid: string; password: string } | null = null;
  // True after the first successful sign-in of this connect(); only then are drops retried.
  let hadSession = false;
  let lastJid = '';
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Identity token of the liveness probe in flight, if any.
  let probe: object | null = null;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
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

  function clearStableTimer(): void {
    if (stableTimer !== null) clearTimeout(stableTimer);
    stableTimer = null;
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

  function suspendRooms(): void {
    for (const room of rooms.values()) {
      if (room.state === 'suspended') continue;
      clearTimer(room);
      room.state = 'suspended';
      emit({ type: 'room-suspended', roomJid: room.roomJid });
    }
  }

  function rejoinRooms(): void {
    for (const room of [...rooms.values()]) {
      if (room.state !== 'suspended') continue;
      // The server may still hold the old nick (or its -N variant); always start from the base nick.
      room.nick = room.baseNick;
      room.attempt = 0;
      room.configuring = false;
      room.occupants = new Set();
      room.state = 'joining';
      sendJoin(room);
    }
  }

  // Terminal: the user must sign in again. Drops credentials, rooms and timers.
  function terminate(error?: ConnectionError): void {
    scheduler.cancel();
    scheduler.reset();
    clearStableTimer();
    probe = null;
    creds = null;
    hadSession = false;
    // Strophe reports failed and then disconnected; the first one wins so the error survives.
    if (state.status === 'disconnected' || state.status === 'idle') return;
    for (const room of [...rooms.values()]) {
      clearTimer(room);
      emit({ type: 'room-left', roomJid: room.roomJid, reason: 'disconnected' });
    }
    rooms.clear();
    setState(error ? { status: 'disconnected', error } : { status: 'disconnected' });
  }

  function attemptNow(): void {
    if (!creds || state.status !== 'reconnecting') return;
    const myGeneration = ++generation;
    lastAttemptAt = now();
    setState({ status: 'reconnecting', jid: state.jid, attempt: state.attempt, nextAttemptAt: null });
    transport.connect(creds.jid, creds.password, (s) => {
      onTransportStatus(s, myGeneration);
    });
  }

  function scheduleRetry(): void {
    if (!creds) {
      terminate();
      return;
    }
    suspendRooms();
    clearStableTimer();
    probe = null;
    const { attempt, at } = scheduler.schedule(attemptNow);
    setState({ status: 'reconnecting', jid: lastJid, attempt, nextAttemptAt: at });
  }

  function onTransportStatus(status: TransportStatus, myGeneration: number): void {
    if (myGeneration !== generation) return;
    switch (status.kind) {
      case 'connecting':
        // While retrying, stay 'reconnecting' so the banner keeps its attempt number.
        if (state.status !== 'reconnecting') setState({ status: 'connecting' });
        break;
      case 'connected':
        scheduler.cancel();
        lastJid = status.jid;
        lastProbeAt = Number.NEGATIVE_INFINITY;
        setState({ status: 'connected', jid: status.jid });
        transport.send(buildPresence());
        hadSession = true;
        clearStableTimer();
        stableTimer = setTimeout(() => {
          stableTimer = null;
          scheduler.reset();
        }, stableAfterMs);
        rejoinRooms();
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
        if (status.reason === 'auth-failed') {
          terminate(error);
        } else if (status.condition === 'conflict') {
          // Another session replaced this one; retrying would only fight it.
          terminate({ reason: 'connection-lost', condition: 'conflict' });
        } else if (hadSession && !userInitiated) {
          scheduleRetry();
        } else {
          terminate(error);
        }
        break;
      }
      case 'disconnected':
        if (userInitiated) {
          terminate();
        } else if (
          hadSession &&
          (state.status === 'connected' || state.status === 'disconnecting')
        ) {
          scheduleRetry();
        } else if (state.status === 'reconnecting') {
          // A preceding 'failed' already scheduled the next attempt; only a bare close needs one.
          if (!scheduler.pending) scheduleRetry();
        } else {
          terminate();
        }
        break;
    }
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
    const gen = generation;
    // TEMPORARY (Phase 3): the single call site of room creation.
    void acceptInstantRoom(transport, room.roomJid, iqTimeoutMs).then((res) => {
      // A drop and rejoin while the IQ was in flight makes this result stale.
      if (generation !== gen || room.state !== 'joining' || !room.configuring) return;
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
    if (!room || room.state === 'suspended') return;
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
        // XEP-0199: the server's keepalive ping must be answered or mod_ping kills the session.
        if (isPingRequest(el)) transport.send(buildIqResult(el));
        else if (type === 'get' || type === 'set') transport.send(buildIqErrorReply(el));
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
      hadSession = false;
      scheduler.reset();
      creds = { jid, password };
      lastJid = jid;
      setState({ status: 'connecting' });
      transport.connect(jid, password, (s) => {
        onTransportStatus(s, myGeneration);
      });
    },

    disconnect() {
      if (state.status === 'reconnecting') {
        // Nothing live to close politely: cancel the retry and go terminal now.
        userInitiated = true;
        generation++;
        scheduler.cancel();
        transport.disconnect('user');
        terminate();
        return;
      }
      if (state.status !== 'connecting' && state.status !== 'connected') return;
      userInitiated = true;
      setState({ status: 'disconnecting' });
      transport.disconnect('user');
    },

    wake(trigger) {
      // Only tab-visibility flaps are throttled; 'online' and 'user' are deliberate and act at once.
      const throttled = trigger === 'visible';
      if (state.status === 'reconnecting') {
        if (!throttled || now() - lastAttemptAt >= wakeMinIntervalMs) scheduler.fireNow();
        return;
      }
      if (state.status !== 'connected' || probe !== null) return;
      if (throttled && now() - lastProbeAt < probeMinIntervalMs) return;
      lastProbeAt = now();
      const mine = {};
      probe = mine;
      const g = generation;
      void transport
        .sendIQ(buildPing(domainOf(state.jid), newId()), probeTimeoutMs)
        .then((res) => {
          if (probe !== mine) return;
          probe = null;
          // Any reply, even an error, proves the link is alive. Only silence means it is not.
          if (res.ok || res.condition !== 'timeout') return;
          if (generation !== g || state.status !== 'connected') return;
          generation++;
          transport.disconnect('stale');
          scheduleRetry();
        });
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
      // A suspended room has no live presence to retract, and nothing can be sent while offline.
      if (room.state !== 'suspended' && state.status === 'connected') {
        transport.send(buildLeavePresence(room.roomJid, room.nick));
      }
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
