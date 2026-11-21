import { describe, expect, it } from 'vitest';
import { initialIdentityState, selectAppView, type IdentityState } from '../../src/state/identity';
import type { ConnectionState } from '../../src/xmpp';

const id = (patch: Partial<IdentityState>): IdentityState => ({ ...initialIdentityState, ...patch });
const active = id({ nickname: 'Alice_1', intent: 'active' });
const signedOut = id({ nickname: 'Alice_1', intent: 'signed-out' });

const CONNECTED: ConnectionState = { status: 'connected', jid: 'u@d/r' };
const RECONNECTING: ConnectionState = {
  status: 'reconnecting',
  jid: 'u@d/r',
  attempt: 1,
  nextAttemptAt: null,
};

describe('selectAppView', () => {
  it.each<[string, ConnectionState]>([
    ['idle', { status: 'idle' }],
    ['connecting', { status: 'connecting' }],
    ['connected', CONNECTED],
    ['disconnected', { status: 'disconnected' }],
  ])('shows onboarding without a nickname (%s)', (_name, c) => {
    expect(selectAppView(id({}), c)).toEqual({ kind: 'onboarding', busy: false, error: null });
  });

  it('carries creating and the onboarding error', () => {
    expect(selectAppView(id({ creating: true }), { status: 'idle' })).toEqual({
      kind: 'onboarding',
      busy: true,
      error: null,
    });
    expect(selectAppView(id({ onboardError: 'taken' }), { status: 'idle' })).toEqual({
      kind: 'onboarding',
      busy: false,
      error: 'taken',
    });
  });

  it.each<[string, ConnectionState]>([
    ['connected', CONNECTED],
    ['reconnecting', RECONNECTING],
  ])('shows the chat while %s', (_name, c) => {
    expect(selectAppView(active, c)).toEqual({ kind: 'chat', nickname: 'Alice_1' });
  });

  it.each<[string, ConnectionState]>([
    ['idle', { status: 'idle' }],
    ['connecting', { status: 'connecting' }],
  ])('shows connecting while %s', (_name, c) => {
    expect(selectAppView(active, c)).toEqual({ kind: 'connecting', nickname: 'Alice_1' });
  });

  it('shows a busy returning card while disconnecting', () => {
    expect(selectAppView(active, { status: 'disconnecting' })).toEqual({
      kind: 'returning',
      nickname: 'Alice_1',
      error: null,
      busy: true,
    });
  });

  it.each<[string, ConnectionState, ReturnType<typeof selectAppView>]>([
    [
      'no error',
      { status: 'disconnected' },
      { kind: 'returning', nickname: 'Alice_1', error: null, busy: false },
    ],
    [
      'auth-failed',
      { status: 'disconnected', error: { reason: 'auth-failed' } },
      { kind: 'returning', nickname: 'Alice_1', error: { reason: 'auth-failed' }, busy: false },
    ],
    [
      'connection-failed',
      { status: 'disconnected', error: { reason: 'connection-failed' } },
      { kind: 'returning', nickname: 'Alice_1', error: { reason: 'connection-failed' }, busy: false },
    ],
  ])('shows the returning card when disconnected with %s', (_name, c, expected) => {
    expect(selectAppView(active, c)).toEqual(expected);
  });

  it.each<[string, ConnectionState, boolean]>([
    ['idle', { status: 'idle' }, false],
    ['connecting', { status: 'connecting' }, false],
    ['connected', CONNECTED, false],
    ['reconnecting', RECONNECTING, false],
    ['disconnecting', { status: 'disconnecting' }, true],
    ['disconnected', { status: 'disconnected' }, false],
    ['disconnected with an error', { status: 'disconnected', error: { reason: 'auth-failed' } }, false],
  ])('signed out is returning with no error, busy only while disconnecting (%s)', (_n, c, busy) => {
    expect(selectAppView(signedOut, c)).toEqual({
      kind: 'returning',
      nickname: 'Alice_1',
      error: null,
      busy,
    });
  });
});
