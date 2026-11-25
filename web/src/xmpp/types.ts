import type { BackoffPolicy } from './reconnect';

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NICK_LENGTH = 32;

export interface ConnectionError {
  reason: 'auth-failed' | 'connection-failed' | 'connection-lost' | 'error';
  condition?: string;
}

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; jid: string }
  /** attempt: 1-based number of the next/in-flight retry. nextAttemptAt: epoch ms, null while an attempt is in flight. jid: last bound full JID. */
  | { status: 'reconnecting'; jid: string; attempt: number; nextAttemptAt: number | null }
  | { status: 'disconnecting' }
  | { status: 'disconnected'; error?: ConnectionError };

export interface ChatMessage {
  /** room stanza-id (urn:xmpp:sid:0, by === roomJid) ?? message @id ?? synthetic fallback */
  id: string;
  roomJid: string;
  /** null = sent by the room itself */
  nick: string | null;
  body: string;
  /** epoch ms: <delay> stamp if valid, else now() */
  sentAt: number;
  /** true iff a valid <delay> is present */
  isHistory: boolean;
  isOwn: boolean;
}

export type JoinFailure =
  | 'conflict'
  | 'not-authorized'
  | 'forbidden'
  | 'registration-required'
  | 'not-allowed'
  | 'service-unavailable'
  | 'not-acceptable'
  | 'item-not-found'
  | 'timeout'
  | 'not-connected'
  | 'invalid-room'
  | 'invalid-nick'
  | 'other';

export type LeaveReason = 'self' | 'kicked' | 'banned' | 'removed' | 'disconnected' | 'other';

/** initial: newest page after a first join; gap: catching up after a reconnect; earlier: "Load earlier messages". */
export type HistoryDirection = 'initial' | 'gap' | 'earlier';

export type XmppEvent =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'room-joining'; roomJid: string; nick: string }
  | { type: 'room-joined'; roomJid: string; nick: string; created: boolean }
  | { type: 'room-join-failed'; roomJid: string; reason: JoinFailure; condition?: string }
  | { type: 'room-left'; roomJid: string; reason: LeaveReason }
  | { type: 'room-suspended'; roomJid: string }
  | { type: 'occupant-joined'; roomJid: string; nick: string; isSelf: boolean }
  | { type: 'occupant-left'; roomJid: string; nick: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message-error'; roomJid: string; condition: string }
  | { type: 'history-loading'; roomJid: string; direction: HistoryDirection }
  | {
      type: 'history-loaded';
      roomJid: string;
      direction: 'initial' | 'gap';
      messages: ChatMessage[];
      done: boolean;
      complete: boolean;
    }
  | {
      type: 'history-loaded';
      roomJid: string;
      direction: 'earlier';
      /** the <before> id this page ends at; the store inserts the page just above it */
      anchorId: string;
      messages: ChatMessage[];
      done: true;
      complete: boolean;
    }
  | { type: 'history-failed'; roomJid: string; direction: HistoryDirection; condition: string };

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: 'not-connected' | 'not-joined' | 'empty' | 'too-long' };

export interface XmppClient {
  getState(): ConnectionState;
  connect(jid: string, password: string): void;
  disconnect(): void;
  joinRoom(roomJid: string, nick: string): void;
  leaveRoom(roomJid: string): void;
  sendGroupchat(roomJid: string, body: string): SendResult;
  /** Re-run history for a joined room after history-failed. No-op if not connected/joined or a query is queued/in flight. */
  retryHistory(roomJid: string): void;
  /** Fetch the page before the oldest loaded history message (24 h window). No-op unless connected, joined,
   *  the initial load has completed, more history exists, and no history query is queued or in flight. */
  loadEarlier(roomJid: string): void;
  subscribe(listener: (e: XmppEvent) => void): () => void;
  /** online / tab visible / "Try now": retry now if reconnecting, liveness-probe if connected, else no-op. */
  wake(trigger: WakeTrigger): void;
}

/** What woke the client. Only 'visible' is throttled; 'online' and 'user' are deliberate. */
export type WakeTrigger = 'visible' | 'online' | 'user';

export interface XmppClientOptions {
  mucDomain: string;
  joinTimeoutMs?: number;
  maxNickRetries?: number;
  /** Messages per history page. Default 50 (= server max_result_limit). */
  mamPageSize?: number;
  /** Max catch-up pages after a reconnect. Default 5. */
  mamMaxGapPages?: number;
  /** Minimum gap (ms) between history queries, across rooms. Default 1_100 (server shaper is 1/s per user). */
  mamMinIntervalMs?: number;
  /** History query timeout (ms). Default 15_000. */
  mamTimeoutMs?: number;
  /** How far back history reaches (ms). Default 86_400_000 (ADR-004). */
  historyWindowMs?: number;
  now?: () => number;
  newId?: () => string;
  backoff?: Partial<BackoffPolicy>;
  /** Staying connected this long (ms) resets the backoff. Default 60_000. */
  stableAfterMs?: number;
  /** Liveness ping timeout (ms). Default 5_000. */
  probeTimeoutMs?: number;
  /** Minimum gap (ms) between wake()-triggered reconnect attempts. Default 5_000. */
  wakeMinIntervalMs?: number;
  /** Minimum gap (ms) between liveness probes. Default 30_000. */
  probeMinIntervalMs?: number;
  /** [0,1) source for backoff jitter. Default Math.random. */
  random?: () => number;
}
