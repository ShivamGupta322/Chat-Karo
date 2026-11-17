import { describe, expect, it } from 'vitest';
import { roomLabel, toAccountJid, toRoomJid } from '../../src/ui/addresses';

const D = 'chaterl.localhost';
const M = 'muc.chaterl.localhost';

describe('toAccountJid', () => {
  it('expands a username', () => {
    expect(toAccountJid('alice', D)).toEqual({ ok: true, jid: `alice@${D}` });
  });
  it('trims and lowercases', () => {
    expect(toAccountJid('  Alice ', D)).toEqual({ ok: true, jid: `alice@${D}` });
  });
  it('accepts a full address on the domain', () => {
    expect(toAccountJid(`bob@${D}`, D)).toEqual({ ok: true, jid: `bob@${D}` });
  });
  it('rejects another domain', () => {
    expect(toAccountJid('alice@evil.example', D)).toEqual({ ok: false, error: 'wrong-domain' });
  });
  it('rejects empty input', () => {
    expect(toAccountJid('', D)).toEqual({ ok: false, error: 'empty' });
    expect(toAccountJid('   ', D)).toEqual({ ok: false, error: 'empty' });
  });
  it.each(['al ice', 'alice/res', '-alice', `alice@${D}/res`])('rejects %j as invalid', (input) => {
    expect(toAccountJid(input, D)).toEqual({ ok: false, error: 'invalid' });
  });
  it('rejects a 65-character username', () => {
    expect(toAccountJid('a'.repeat(65), D)).toEqual({ ok: false, error: 'invalid' });
    expect(toAccountJid('a'.repeat(64), D).ok).toBe(true);
  });
});

describe('toRoomJid', () => {
  it('expands a room name', () => {
    expect(toRoomJid('lobby', M)).toEqual({ ok: true, jid: `lobby@${M}` });
  });
  it('accepts a full address on the MUC domain', () => {
    expect(toRoomJid(`lobby@${M}`, M)).toEqual({ ok: true, jid: `lobby@${M}` });
  });
  it('rejects another domain', () => {
    expect(toRoomJid('lobby@evil.example', M)).toEqual({ ok: false, error: 'wrong-domain' });
  });
  it('does not lowercase: uppercase is invalid', () => {
    expect(toRoomJid('Lobby', M)).toEqual({ ok: false, error: 'invalid' });
  });
  it('rejects empty input', () => {
    expect(toRoomJid('', M)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('roomLabel', () => {
  it('returns the localpart', () => {
    expect(roomLabel('g7_gcpvj0e@muc.x')).toBe('g7_gcpvj0e');
  });
  it('returns the whole string without an @', () => {
    expect(roomLabel('lobby')).toBe('lobby');
  });
});
