import { create } from 'zustand';
import { describeMessageError } from '../ui/text';
import type { ChatMessage, JoinFailure, LeaveReason, XmppEvent } from '../xmpp/types';

export const MAX_TIMELINE = 500;

export type TimelineItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'notice'; id: string; text: string; at: number };

export interface RoomState {
  roomJid: string | null;
  nick: string | null;
  status: 'none' | 'joining' | 'joined' | 'failed' | 'left';
  failure: { reason: JoinFailure; condition?: string } | null;
  leftReason: LeaveReason | null;
  occupants: string[];
  timeline: TimelineItem[];
}

export const initialRoomState: RoomState = {
  roomJid: null,
  nick: null,
  status: 'none',
  failure: null,
  leftReason: null,
  occupants: [],
  timeline: [],
};

let noticeSeq = 0;

function notice(text: string): TimelineItem {
  noticeSeq += 1;
  return { kind: 'notice', id: `notice-${noticeSeq}`, text, at: Date.now() };
}

function cap(items: TimelineItem[]): TimelineItem[] {
  return items.length > MAX_TIMELINE ? items.slice(items.length - MAX_TIMELINE) : items;
}

function addOccupant(list: string[], nick: string): string[] {
  if (list.includes(nick)) return list;
  return [...list, nick].sort((a, b) => a.localeCompare(b));
}

export function reduceRoom(state: RoomState, event: XmppEvent): RoomState {
  switch (event.type) {
    case 'connection':
      return state;
    case 'message-error':
      if (event.roomJid !== state.roomJid) return state;
      return {
        ...state,
        timeline: cap([
          ...state.timeline,
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
    return {
      ...state,
      timeline: cap([...state.timeline, { kind: 'message', message: event.message }]),
    };
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
    case 'room-left':
      return { ...state, status: 'left', leftReason: event.reason, occupants: [] };
    case 'occupant-joined': {
      const occupants = addOccupant(state.occupants, event.nick);
      if (state.status !== 'joined' || event.isSelf) {
        return occupants === state.occupants ? state : { ...state, occupants };
      }
      return {
        ...state,
        occupants,
        timeline: cap([...state.timeline, notice(`${event.nick} joined`)]),
      };
    }
    case 'occupant-left': {
      const occupants = state.occupants.filter((n) => n !== event.nick);
      if (state.status !== 'joined') return { ...state, occupants };
      return {
        ...state,
        occupants,
        timeline: cap([...state.timeline, notice(`${event.nick} left`)]),
      };
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
