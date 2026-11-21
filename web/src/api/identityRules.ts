// Shared shape rules for server-issued identity values (ADR-017). Used by session.ts and deviceCredential.ts.
import { NICKNAME_RE } from './nickname';

const PASSWORD_RE = /^xp1_[A-Za-z0-9_-]{32}$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function jidPattern(xmppDomain: string): RegExp {
  return new RegExp(`^u[0-9a-f]{32}@${escapeRegExp(xmppDomain)}$`);
}

export function isValidPassword(v: unknown): v is string {
  return typeof v === 'string' && PASSWORD_RE.test(v);
}

export function isValidNickname(v: unknown): v is string {
  return typeof v === 'string' && NICKNAME_RE.test(v);
}
