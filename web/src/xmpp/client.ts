import { domainOf, isValidRoomJid, normalizeNick } from './jid';
import { DEFAULT_BACKOFF, createRetryScheduler } from './reconnect';
import { buildMamQuery, isMamResultMessage, parseMamFin, parseMamResult, type MamItem } from './mam';
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
  type ChatMessage,
  type ConnectionState,
  type HistoryDirection,
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
  /** Newest known stanza-id (live or history). Survives suspend/rejoin; drives the catch-up query. */
  lastSeenId: string | null;
  /** The initial (last 24 h) load has completed at least once, so lastSeenId is a valid gap anchor. */
  initialDone: boolean;
  /** A live message with a stanza-id arrived since the current history run started. */
  liveSinceHistory: boolean;
  /** The history query queued or in flight, with the result messages buffered so far. */
  mam: {
    queryId: string;
    direction: HistoryDirection;
    page: number;
    buffer: MamItem[];
    startMs: number;
  } | null;
  mamTimer: ReturnType<typeof setTimeout> | null;
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
  const mamPageSize = options.mamPageSize ?? 50;
  const mamMaxGapPages = options.mamMaxGapPages ?? 5;
  const mamMinIntervalMs = options.mamMinIntervalMs ?? 1_100;
  const mamTimeoutMs = options.mamTimeoutMs ?? 15_000;
  const historyWindowMs = options.historyWindowMs ?? 86_400_000;
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
  // Earliest time the next history query may be sent. Global: the server's MAM shaper is per user.
  let nextMamAt = Number.NEGATIVE_INFINITY;
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

  function cancelHistory(room: TrackedRoom): void {
    if (room.mamTimer !== null) {
      clearTimeout(room.mamTimer);
      room.mamTimer = null;
    }
    room.mam = null;
  }

  function untrack(room: TrackedRoom): void {
    clearTimer(room);
    cancelHistory(room);
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
    transport.send(buildJoinPresence(room.roomJid, room.nick, 0));
    emit({ type: 'room-joining', roomJid: room.roomJid, nick: room.nick });
    startJoinTimer(room);
  }

  function suspendRooms(): void {
    for (const room of rooms.values()) {
      if (room.state === 'suspended') continue;
      clearTimer(room);
      cancelHistory(room);
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
      cancelHistory(room);
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
    startHistory(room);
  }

  function startHistory(room: TrackedRoom): void {
    if (state.status !== 'connected' || room.state !== 'joined' || room.mam || room.mamTimer) {
      return;
    }
    room.liveSinceHistory = false;
    // A live message may set lastSeenId before the first load finished; only a completed
    // initial load makes the anchor a valid gap start.
    const direction: HistoryDirection =
      room.initialDone && room.lastSeenId !== null ? 'gap' : 'initial';
    emit({ type: 'history-loading', roomJid: room.roomJid, direction });
    schedulePage(room, direction, direction === 'gap' ? room.lastSeenId : null, 1);
  }

  function schedulePage(
    room: TrackedRoom,
    direction: HistoryDirection,
    after: string | null,
    page: number,
  ): void {
    const wait = Math.max(0, nextMamAt - now());
    nextMamAt = now() + wait + mamMinIntervalMs;
    if (wait === 0) {
      sendPage(room, direction, after, page);
      return;
    }
    // Mark the query as queued so retry/startHistory cannot double up.
    // startMs is never used for parsing: results are ignored while queryId === ''.
    room.mam = { queryId: '', direction, page, buffer: [], startMs: 0 };
    room.mamTimer = setTimeout(() => {
      room.mamTimer = null;
      room.mam = null;
      if (rooms.get(room.roomJid) !== room || room.state !== 'joined') return;
      sendPage(room, direction, after, page);
    }, wait);
  }

  function failHistory(room: TrackedRoom, direction: HistoryDirection, condition: string): void {
    emit({ type: 'history-failed', roomJid: room.roomJid, direction, condition });
  }

  function sendPage(
    room: TrackedRoom,
    direction: HistoryDirection,
    after: string | null,
    page: number,
  ): void {
    const g = generation;
    const queryId = newId();
    const startMs = now() - historyWindowMs;
    room.mam = { queryId, direction, page, buffer: [], startMs };
    const query = buildMamQuery({
      roomJid: room.roomJid,
      iqId: newId(),
      queryId,
      startIso: new Date(startMs).toISOString(),
      max: mamPageSize,
      page: after === null ? { before: true } : { after },
    });
    void transport.sendIQ(query, mamTimeoutMs).then((res) => {
      if (
        generation !== g ||
        rooms.get(room.roomJid) !== room ||
        room.state !== 'joined' ||
        room.mam?.queryId !== queryId
      ) {
        return;
      }
      const buffer = room.mam.buffer;
      room.mam = null;
      if (!res.ok) {
        if (direction === 'gap' && page === 1 && res.condition === 'item-not-found') {
          // The anchor is gone (e.g. purged): fall back to the newest page, once.
          room.lastSeenId = null;
          room.initialDone = false;
          emit({ type: 'history-loading', roomJid: room.roomJid, direction: 'initial' });
          schedulePage(room, 'initial', null, 1);
          return;
        }
        failHistory(room, direction, res.condition);
        return;
      }
      const fin = parseMamFin(res.stanza);
      if (fin === null) {
        failHistory(room, direction, 'bad-response');
        return;
      }
      const messages: ChatMessage[] = buffer.map((item) => ({
        id: item.id,
        roomJid: room.roomJid,
        nick: item.nick,
        body: item.body,
        sentAt: item.sentAt,
        isHistory: true,
        isOwn: item.nick !== null && item.nick === room.nick,
      }));
      const lastItem = buffer.at(-1);
      if (!room.liveSinceHistory && lastItem !== undefined) room.lastSeenId = lastItem.id;
      if (direction === 'initial') {
        room.initialDone = true;
        emit({
          type: 'history-loaded',
          roomJid: room.roomJid,
          direction,
          messages,
          done: true,
          complete: fin.complete,
        });
        return;
      }
      const done =
        fin.complete || buffer.length === 0 || fin.last === null || page >= mamMaxGapPages;
      emit({
        type: 'history-loaded',
        roomJid: room.roomJid,
        direction,
        messages,
        done,
        complete: fin.complete,
      });
      if (!done) schedulePage(room, 'gap', fin.last, page + 1);
    });
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
    if (isMamResultMessage(el)) {
      // Never a live message. Only accepted while our own query is in flight (anti-spoof inside).
      const mam = room.mam;
      if (mam && mam.queryId !== '') {
        const item = parseMamResult(el, {
          roomJid: room.roomJid,
          queryId: mam.queryId,
          notBefore: mam.startMs,
        });
        if (item !== null && mam.buffer.length < mamPageSize) mam.buffer.push(item);
      }
      return;
    }
    if (type === 'error') {
      emit({ type: 'message-error', roomJid: room.roomJid, condition: parseErrorCondition(el) });
      return;
    }
    const m = parseGroupchat(el);
    if (!m) return;
    const sentAt = m.delayedAt ?? now();
    if (m.stanzaId !== null) {
      room.lastSeenId = m.stanzaId;
      room.liveSinceHistory = true;
    }
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
        lastSeenId: null,
        initialDone: false,
        liveSinceHistory: false,
        mam: null,
        mamTimer: null,
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

    retryHistory(roomJid) {
      const room = rooms.get(roomJid);
      if (room) startHistory(room);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
