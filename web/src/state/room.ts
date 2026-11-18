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

/** Appends to the end; an append trims the front, so the history anchor moves down with it. */
function append(state: RoomState, items: readonly TimelineItem[]): Placed {
  const next = [...state.timeline, ...items];
  const trimmed = Math.max(0, next.length - MAX_TIMELINE);
  if (trimmed === 0) return { timeline: next, history: state.history };
  return {
    timeline: next.slice(trimmed),
    history: { ...state.history, insertAt: Math.max(0, state.history.insertAt - trimmed) },
  };
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

function addOccupant(list: string[], nick: string): string[] {
  if (list.includes(nick)) return list;
  return [...list, nick].sort((a, b) => a.localeCompare(b));
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
          history: state.history.loading ? { ...state.history, loading: false } : state.history,
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
        history: state.history.loading ? { ...state.history, loading: false } : state.history,
      };
    case 'room-left':
      return { ...state, status: 'left', leftReason: event.reason, occupants: [] };
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
      if (h.loading && !h.failed) return state;
      return { ...state, history: { ...h, loading: true, failed: false } };
    }
    case 'history-failed': {
      const h = state.history;
      if (!h.loading && h.failed) return state;
      return { ...state, history: { ...h, loading: false, failed: true } };
    }
    case 'history-loaded': {
      const h = state.history;
      const merged = mergeHistory(state.timeline, h.insertAt, event.messages);
      let timeline = merged.timeline;
      let insertAt = merged.insertAt;
      if (event.direction === 'gap' && event.done && !event.complete) {
        const placed = insertCapped(timeline, insertAt, [notice(HISTORY_TEXT.gapTruncated)]);
        timeline = placed.timeline;
        insertAt = placed.insertAt;
      }
      const loading = event.done ? false : h.loading;
      const canLoadEarlier =
        event.direction === 'initial' && event.done ? !event.complete : h.canLoadEarlier;
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
