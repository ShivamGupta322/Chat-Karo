import { describe, expect, it } from 'vitest';
import { bareJid, isValidRoomJid, localpartOf, normalizeNick, resourceOf } from '../../src/xmpp/jid';

const MUC = 'muc.chaterl.localhost';

describe('jid helpers', () => {
  it('splits bare/resource/localpart', () => {
    expect(bareJid('a@b/c')).toBe('a@b');
    expect(resourceOf('a@b/c')).toBe('c');
    expect(localpartOf('a@b/c')).toBe('a');
  });
  it('handles a JID without a resource', () => {
    expect(bareJid('a@b')).toBe('a@b');
    expect(resourceOf('a@b')).toBeNull();
    expect(localpartOf('a@b')).toBe('a');
    expect(localpartOf('')).toBe('');
  });
});

describe('isValidRoomJid', () => {
  it('accepts valid rooms', () => {
    expect(isValidRoomJid(`lobby@${MUC}`, MUC)).toBe(true);
    expect(isValidRoomJid(`g7_gcpvj0e@${MUC}`, MUC)).toBe(true);
  });
  it.each([`Room@${MUC}`, 'room@muc.other', `room@${MUC}/x`, '', `ro om@${MUC}`])(
    'rejects %j',
    (jid) => {
      expect(isValidRoomJid(jid, MUC)).toBe(false);
    },
  );
});

describe('normalizeNick', () => {
  it('trims', () => {
    expect(normalizeNick('  bob ')).toBe('bob');
  });
  it('rejects empty', () => {
    expect(normalizeNick('   ')).toBeNull();
  });
  it('limits to 32 code points', () => {
    expect(normalizeNick('a'.repeat(32))).not.toBeNull();
    expect(normalizeNick('a'.repeat(33))).toBeNull();
  });
  it('counts an emoji as one code point', () => {
    expect(normalizeNick('😀'.repeat(32))).not.toBeNull();
    expect(normalizeNick('😀'.repeat(33))).toBeNull();
  });
  it('rejects control characters', () => {
    expect(normalizeNick('a\u0007b')).toBeNull();
  });
});
