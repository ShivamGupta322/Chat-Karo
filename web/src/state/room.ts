import { create } from 'zustand';
import { describeMessageError, HISTORY_TEXT } from '../ui/text';
import type { ChatMessage, JoinFailure, LeaveReason, XmppEvent } from '../xmpp/types';

export const MAX_TIMELINE = 500;

export type TimelineItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'notice'; id: string; text: string; at: number };

/**
 * History bookkeeping. insertAt is the timeline index where the next history batch lands: the timeline
 * length at the latest room-joined, advanced per insert and shifted down when the cap trims the front.
 */
export interface RoomHistory {
  loading: boolean;
  failed: boolean;
  canLoadEarlier: boolean;
  insertAt: number;
  /** State of the "Load earlier messages" query; independent of loading/failed (recent history). */
  earlier: 'idle' | 'loading' | 'failed';
}

export interface RoomState {
  roomJid: string | null;
  nick: string | null;
  status: 'none' | 'joining' | 'joined' | 'failed' | 'left' | 'reconnecting';
  failure: { reason: JoinFailure; condition?: string } | null;
  leftReason: LeaveReason | null;
  occupants: string[];
  timeline: TimelineItem[];
  history: RoomHistory;
}

const initialHistory: RoomHistory = {
  loading: false,
  failed: false,
  canLoadEarlier: false,
  insertAt: 0,
  earlier: 'idle',
};

export const initialRoomState: RoomState = {
  roomJid: null,
  nick: null,
  status: 'none',
  failure: null,
  leftReason: null,
  occupants: [],
  timeline: [],
  history: initialHistory,
};

let noticeSeq = 0;

function notice(text: string): TimelineItem {
  noticeSeq += 1;
  return { kind: 'notice', id: `notice-${noticeSeq}`, text, at: Date.now() };
}

type Placed = Pick<RoomState, 'timeline' | 'history'>;

/** Inserts items at `at` (clamped), trims the front to MAX_TIMELINE and shifts the anchor by the trimmed count. */
function insertCapped(
  timeline: TimelineItem[],
  insertAt: number,
  items: readonly TimelineItem[],
): { timeline: TimelineItem[]; insertAt: number } {
  const at = Math.min(Math.max(insertAt, 0), timeline.length);
  const next = [...timeline.slice(0, at), ...items, ...timeline.slice(at)];
  const trimmed = Math.max(0, next.length - MAX_TIMELINE);
  return {
    timeline: trimmed > 0 ? next.slice(trimmed) : next,
    insertAt: Math.max(0, at + items.length - trimmed),
  };
}

/** Once the timeline is full, "Load earlier" is withdrawn for the room session. Same reference otherwise. */
function withEarlierCap(history: RoomHistory, timeline: readonly TimelineItem[]): RoomHistory {
  return history.canLoadEarlier && timeline.length >= MAX_TIMELINE
    ? { ...history, canLoadEarlier: false }
    : history;
}

/** Appends to the end; an append trims the front, so the history anchor moves down with it. */
function append(state: RoomState, items: readonly TimelineItem[]): Placed {
  const next = [...state.timeline, ...items];
  const trimmed = Math.max(0, next.length - MAX_TIMELINE);
  if (trimmed === 0) {
    return { timeline: next, history: withEarlierCap(state.history, next) };
  }
  const timeline = next.slice(trimmed);
  const history = { ...state.history, insertAt: Math.max(0, state.history.insertAt - trimmed) };
  return { timeline, history: withEarlierCap(history, timeline) };
}

/**
 * De-dupes `messages` against the timeline and within the batch, then inserts the rest in order at `insertAt`.
 * Returns the same timeline reference when nothing new was inserted.
 */
export function mergeHistory(
  timeline: TimelineItem[],
  insertAt: number,
  messages: readonly ChatMessage[],
): { timeline: TimelineItem[]; insertAt: number } {
  const seen = new Set<string>();
  for (const t of timeline) if (t.kind === 'message') seen.add(t.message.id);
  const fresh: TimelineItem[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    fresh.push({ kind: 'message', message: m });
  }
  const clamped = Math.min(Math.max(insertAt, 0), timeline.length);
  if (fresh.length === 0) return { timeline, insertAt: clamped };
  return insertCapped(timeline, clamped, fresh);
}

/**
 * De-dupes `messages` against the timeline and within the batch, then inserts the freshest that fit
 * (at most MAX_TIMELINE - timeline.length, keeping the NEWEST ones, in order) directly before the message
 * with id === anchorId, or at index 0 if it is absent. Never trims existing items. insertAt moves up by the
 * inserted count when the insertion index is at or below it. truncated = some fresh messages were dropped.
 * Returns the same timeline reference (and insertAt) when nothing was inserted.
 */
export function mergeEarlier(
  timeline: TimelineItem[],
  insertAt: number,
  anchorId: string,
  messages: readonly ChatMessage[],
): { timeline: TimelineItem[]; insertAt: number; truncated: boolean } {
  const seen = new Set<string>();
  for (const t of timeline) if (t.kind === 'message') seen.add(t.message.id);
  const fresh: TimelineItem[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    fresh.push({ kind: 'message', message: m });
  }
  const free = Math.max(0, MAX_TIMELINE - timeline.length);
  const keep = fresh.length <= free ? fresh : free === 0 ? [] : fresh.slice(-free);
  const truncated = keep.length < fresh.length;
  if (keep.length === 0) return { timeline, insertAt, truncated };
  const idx = timeline.findIndex((t) => t.kind === 'message' && t.message.id === anchorId);
  const at = idx < 0 ? 0 : idx;
  return {
    timeline: [...timeline.slice(0, at), ...keep, ...timeline.slice(at)],
    insertAt: at <= insertAt ? insertAt + keep.length : insertAt,
    truncated,
  };
}

function addOccupant(list: string[], nick: string): string[] {
  if (list.includes(nick)) return list;
  return [...list, nick].sort((a, b) => a.localeCompare(b));
}

/** A cancelled query must not leave a spinner behind: clears loading and the earlier state. */
function resetInFlight(h: RoomHistory): RoomHistory {
  return h.loading || h.earlier !== 'idle' ? { ...h, loading: false, earlier: 'idle' } : h;
}

function isInitial(s: RoomState): boolean {
  return (
    s.roomJid === null &&
    s.nick === null &&
    s.status === 'none' &&
    s.failure === null &&
    s.leftReason === null &&
    s.occupants.length === 0 &&
    s.timeline.length === 0 &&
    s.history === initialHistory
  );
}

export function reduceRoom(state: RoomState, event: XmppEvent): RoomState {
  switch (event.type) {
    case 'connection':
      // Only a terminal disconnect clears the timeline; drops arrive as 'reconnecting' and keep it.
      if (event.state.status !== 'disconnected') return state;
      return isInitial(state) ? state : { ...initialRoomState };
    case 'message-error':
      if (event.roomJid !== state.roomJid) return state;
      return {
        ...state,
        ...append(state, [
          notice(`Message not delivered: ${describeMessageError(event.condition)}`),
        ]),
      };
    case 'room-joining': {
      if (state.roomJid === event.roomJid) {
        return {
          ...state,
          nick: event.nick,
          status: 'joining',
          failure: null,
          leftReason: null,
          history: resetInFlight(state.history),
        };
      }
      return {
        ...initialRoomState,
        roomJid: event.roomJid,
        nick: event.nick,
        status: 'joining',
      };
    }
    default:
      break;
  }

  if (event.type === 'message') {
    if (event.message.roomJid !== state.roomJid) return state;
    const id = event.message.id;
    if (state.timeline.some((t) => t.kind === 'message' && t.message.id === id)) return state;
    return { ...state, ...append(state, [{ kind: 'message', message: event.message }]) };
  }

  if (event.roomJid !== state.roomJid) return state;

  switch (event.type) {
    case 'room-joined':
      return {
        ...state,
        nick: event.nick,
        status: 'joined',
        failure: null,
        leftReason: null,
        history: { ...state.history, insertAt: state.timeline.length, failed: false },
      };
    case 'room-join-failed':
      return {
        ...state,
        status: 'failed',
        failure:
          event.condition !== undefined
            ? { reason: event.reason, condition: event.condition }
            : { reason: event.reason },
        occupants: [],
      };
    case 'room-suspended':
      return {
        ...state,
        status: 'reconnecting',
        occupants: [],
        history: resetInFlight(state.history),
      };
    case 'room-left':
      return {
        ...state,
        status: 'left',
        leftReason: event.reason,
        occupants: [],
        history:
          state.history.earlier === 'idle' ? state.history : { ...state.history, earlier: 'idle' },
      };
    case 'occupant-joined': {
      const occupants = addOccupant(state.occupants, event.nick);
      if (state.status !== 'joined' || event.isSelf) {
        return occupants === state.occupants ? state : { ...state, occupants };
      }
      return { ...state, occupants, ...append(state, [notice(`${event.nick} joined`)]) };
    }
    case 'occupant-left': {
      const occupants = state.occupants.filter((n) => n !== event.nick);
      if (state.status !== 'joined') return { ...state, occupants };
      return { ...state, occupants, ...append(state, [notice(`${event.nick} left`)]) };
    }
    case 'history-loading': {
      const h = state.history;
      if (event.direction === 'earlier') {
        if (h.earlier === 'loading') return state;
        return { ...state, history: { ...h, earlier: 'loading' } };
      }
      if (h.loading && !h.failed) return state;
      return { ...state, history: { ...h, loading: true, failed: false } };
    }
    case 'history-failed': {
      const h = state.history;
      if (event.direction === 'earlier') {
        if (h.earlier === 'failed') return state;
        return { ...state, history: { ...h, earlier: 'failed' } };
      }
      if (!h.loading && h.failed) return state;
      return { ...state, history: { ...h, loading: false, failed: true } };
    }
    case 'history-loaded': {
      const h = state.history;
      if (event.direction === 'earlier') {
        const m = mergeEarlier(state.timeline, h.insertAt, event.anchorId, event.messages);
        const canLoadEarlier = !event.complete && !m.truncated && m.timeline.length < MAX_TIMELINE;
        if (
          m.timeline === state.timeline &&
          h.earlier === 'idle' &&
          h.canLoadEarlier === canLoadEarlier
        ) {
          return state;
        }
        return {
          ...state,
          timeline: m.timeline,
          history: { ...h, insertAt: m.insertAt, earlier: 'idle', canLoadEarlier },
        };
      }
      const merged = mergeHistory(state.timeline, h.insertAt, event.messages);
      let timeline = merged.timeline;
      let insertAt = merged.insertAt;
      if (event.direction === 'gap' && event.done && !event.complete) {
        const placed = insertCapped(timeline, insertAt, [notice(HISTORY_TEXT.gapTruncated)]);
        timeline = placed.timeline;
        insertAt = placed.insertAt;
      }
      const loading = event.done ? false : h.loading;
      const wanted =
        event.direction === 'initial' && event.done ? !event.complete : h.canLoadEarlier;
      const canLoadEarlier = wanted && timeline.length < MAX_TIMELINE;
      if (
        timeline === state.timeline &&
        insertAt === h.insertAt &&
        loading === h.loading &&
        canLoadEarlier === h.canLoadEarlier
      ) {
        return state;
      }
      return { ...state, timeline, history: { ...h, insertAt, loading, canLoadEarlier } };
    }
  }
}

interface RoomStore extends RoomState {
  apply: (event: XmppEvent) => void;
}

export const useRoomStore = create<RoomStore>((set) => ({
  ...initialRoomState,
  apply: (event) => {
    set((s) => {
      const next = reduceRoom(s, event);
      return next === s ? s : next;
    });
  },
}));
