export const NICKNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;

export type NicknameResult =
  | { ok: true; value: string }
  | { ok: false; error: 'empty' | 'invalid' };

/** Trims, then checks the nickname rule. The server stays the authority; this only saves a round trip. */
export function validateNickname(raw: string): NicknameResult {
  const value = raw.trim();
  if (value === '') return { ok: false, error: 'empty' };
  if (!NICKNAME_RE.test(value)) return { ok: false, error: 'invalid' };
  return { ok: true, value };
}
