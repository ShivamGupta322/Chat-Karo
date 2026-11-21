import { create } from 'zustand';
import type { TokenStatus } from '../api';
import type { ConnectionError, ConnectionState } from '../xmpp/types';

export type OnboardError = 'empty' | 'invalid' | 'taken' | 'unavailable' | 'failed';

/** Never holds the XMPP password or the API token: only what the UI needs to show. */
export interface IdentityState {
  /** null = no credential on this device */
  nickname: string | null;
  intent: 'none' | 'active' | 'signed-out';
  creating: boolean;
  onboardError: OnboardError | null;
  /** false after a failed storage write */
  remembered: boolean;
  token: TokenStatus['kind'];
}

export const initialIdentityState: IdentityState = {
  nickname: null,
  intent: 'none',
  creating: false,
  onboardError: null,
  remembered: true,
  token: 'idle',
};

export const useIdentityStore = create<IdentityState>(() => ({ ...initialIdentityState }));

export type AppView =
  | { kind: 'onboarding'; busy: boolean; error: OnboardError | null }
  | { kind: 'connecting'; nickname: string }
  | { kind: 'chat'; nickname: string }
  | { kind: 'returning'; nickname: string; error: ConnectionError | null; busy: boolean };

export function selectAppView(id: IdentityState, c: ConnectionState): AppView {
  const { nickname } = id;
  if (nickname === null) return { kind: 'onboarding', busy: id.creating, error: id.onboardError };
  if (id.intent === 'signed-out') {
    return { kind: 'returning', nickname, error: null, busy: c.status === 'disconnecting' };
  }
  switch (c.status) {
    case 'connected':
    case 'reconnecting':
      return { kind: 'chat', nickname };
    case 'idle':
    case 'connecting':
      return { kind: 'connecting', nickname };
    case 'disconnecting':
      return { kind: 'returning', nickname, error: null, busy: true };
    case 'disconnected':
      return { kind: 'returning', nickname, error: c.error ?? null, busy: false };
  }
}
