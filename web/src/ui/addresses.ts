import { isValidRoomJid } from '../xmpp';

export type AccountJidResult =
  | { ok: true; jid: string }
  | { ok: false; error: 'empty' | 'invalid' | 'wrong-domain' };

export type RoomJidResult =
  | { ok: true; jid: string }
  | { ok: false; error: 'empty' | 'invalid' | 'wrong-domain' };

const ACCOUNT_LOCALPART = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Accepts a bare username or a full address on `domain`. Input is lowercased. */
export function toAccountJid(input: string, domain: string): AccountJidResult {
  const value = input.trim().toLowerCase();
  if (value === '') return { ok: false, error: 'empty' };
  if (value.includes('/')) return { ok: false, error: 'invalid' };
  const at = value.indexOf('@');
  const local = at < 0 ? value : value.slice(0, at);
  if (!ACCOUNT_LOCALPART.test(local)) return { ok: false, error: 'invalid' };
  if (at < 0) return { ok: true, jid: `${local}@${domain}` };
  if (value.slice(at + 1) !== domain) return { ok: false, error: 'wrong-domain' };
  return { ok: true, jid: value };
}

/** Accepts a room name or a full address on `mucDomain`. Case is preserved (uppercase is invalid). */
export function toRoomJid(input: string, mucDomain: string): RoomJidResult {
  const value = input.trim();
  if (value === '') return { ok: false, error: 'empty' };
  const at = value.indexOf('@');
  if (at >= 0 && value.slice(at + 1) !== mucDomain) return { ok: false, error: 'wrong-domain' };
  const jid = at < 0 ? `${value}@${mucDomain}` : value;
  if (!isValidRoomJid(jid, mucDomain)) return { ok: false, error: 'invalid' };
  return { ok: true, jid };
}

/** The room's localpart for display; the whole string if there is no '@'. */
export function roomLabel(roomJid: string): string {
  const at = roomJid.indexOf('@');
  return at < 0 ? roomJid : roomJid.slice(0, at);
}
