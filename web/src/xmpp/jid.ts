import { MAX_NICK_LENGTH } from './types';

export function bareJid(jid: string): string {
  const i = jid.indexOf('/');
  return i < 0 ? jid : jid.slice(0, i);
}

export function resourceOf(jid: string): string | null {
  const i = jid.indexOf('/');
  return i < 0 || i === jid.length - 1 ? null : jid.slice(i + 1);
}

export function localpartOf(jid: string): string {
  const bare = bareJid(jid);
  const i = bare.indexOf('@');
  return i < 0 ? '' : bare.slice(0, i);
}

const ROOM_LOCALPART = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function isValidRoomJid(jid: string, mucDomain: string): boolean {
  const at = jid.indexOf('@');
  if (at < 0) return false;
  return jid.slice(at + 1) === mucDomain && ROOM_LOCALPART.test(jid.slice(0, at));
}

export function normalizeNick(raw: string): string | null {
  const nick = raw.trim();
  const len = [...nick].length;
  if (len < 1 || len > MAX_NICK_LENGTH) return null;
  if (/\p{Cc}/u.test(nick)) return null;
  return nick;
}
