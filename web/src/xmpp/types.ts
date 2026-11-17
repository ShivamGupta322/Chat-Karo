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
  | 'service-unavailable'
  | 'not-acceptable'
  | 'item-not-found'
  | 'timeout'
  | 'room-config-failed'
  | 'not-connected'
  | 'invalid-room'
  | 'invalid-nick'
  | 'other';

export type LeaveReason = 'self' | 'kicked' | 'banned' | 'disconnected' | 'other';

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
  | { type: 'message-error'; roomJid: string; condition: string };

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
  subscribe(listener: (e: XmppEvent) => void): () => void;
  /** online / tab visible / "Try now": retry now if reconnecting, liveness-probe if connected, else no-op. */
  wake(trigger: WakeTrigger): void;
}

/** What woke the client. Only 'visible' is throttled; 'online' and 'user' are deliberate. */
export type WakeTrigger = 'visible' | 'online' | 'user';

export interface XmppClientOptions {
  mucDomain: string;
  joinTimeoutMs?: number;
  iqTimeoutMs?: number;
  maxNickRetries?: number;
  historyMaxStanzas?: number;
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
