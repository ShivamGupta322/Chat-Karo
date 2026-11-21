// Owns the device identity lifecycle outside React (like the XMPP client). Silent by design: no console calls.
// The XMPP password lives in `cred` (a closure) and goes only to client.connect(); it never enters Zustand.
import {
  validateNickname,
  type ApiError,
  type ApiResult,
  type CredentialStore,
  type CreatedSession,
  type DeviceCredential,
  type SessionApi,
  type TokenAccess,
  type TokenManager,
} from '../api';
import type { XmppClient } from '../xmpp/types';
import { initialIdentityState, useIdentityStore, type OnboardError } from './identity';

export interface IdentityController {
  // Property syntax (not methods): the UI passes these around unbound.
  start: () => void;
  /** Never rejects. */
  onboard: (nickname: string) => Promise<void>;
  /** "Continue as X" and "Try again". */
  continueSession: () => void;
  signOut: () => void;
  /** Call only after the user confirmed. */
  startOver: () => void;
  /** For tests and HMR. */
  dispose: () => void;
  /** Seam for 3e-3 (/api/locate). */
  readonly tokens: TokenAccess;
}

function mapCreateError(e: ApiError): OnboardError {
  switch (e.kind) {
    case 'http':
      if (e.status === 400) return 'invalid';
      if (e.status === 409) return 'taken';
      if (e.status === 502 || e.status === 503 || e.status === 504) return 'unavailable';
      return 'failed';
    case 'timeout':
    case 'network':
      return 'unavailable';
    default:
      return 'failed';
  }
}

export function createIdentityController(d: {
  client: XmppClient;
  credentials: CredentialStore;
  session: SessionApi;
  tokens: TokenManager;
  store?: typeof useIdentityStore;
}): IdentityController {
  const { client, credentials, session, tokens } = d;
  const store = d.store ?? useIdentityStore;
  let cred: DeviceCredential | null = null;
  let pending: { cancel: () => void } | null = null;
  let disposed = false;

  const cancelPending = (): void => {
    pending?.cancel();
    pending = null;
  };

  const isIdle = (): boolean => {
    const s = client.getState().status;
    return s === 'idle' || s === 'disconnected';
  };

  /** Connect now if the client is idle; otherwise on its first idle/disconnected state. At most one pending connect. */
  function connectWhenIdle(c: DeviceCredential): void {
    cancelPending();
    if (isIdle()) {
      client.connect(c.jid, c.xmppPassword);
      return;
    }
    let cancelled = false;
    const unsubscribe = client.subscribe((e) => {
      if (e.type !== 'connection') return;
      if (e.state.status !== 'idle' && e.state.status !== 'disconnected') return;
      unsubscribe();
      // Deferred: connecting inside the client's own emit would deliver "connecting" to the other
      // listeners before they have seen "disconnected".
      queueMicrotask(() => {
        if (cancelled || disposed) return;
        pending = null;
        if (isIdle()) client.connect(c.jid, c.xmppPassword);
      });
    });
    pending = {
      cancel: () => {
        cancelled = true;
        unsubscribe();
      },
    };
  }

  const unsubTokens = tokens.subscribe((s) => {
    store.setState({ token: s.kind });
  });
  // A terminal disconnect (auth-failed, connection-failed, conflict, pagehide) ends the token's use too.
  // 'reconnecting' is not terminal, and a renew failure never touches XMPP.
  const unsubClient = client.subscribe((e) => {
    // `pending !== null` means this disconnect completes the previous session and a new connect is queued: not terminal.
    if (
      e.type === 'connection' &&
      e.state.status === 'disconnected' &&
      store.getState().intent === 'active' &&
      pending === null
    ) {
      tokens.stop();
    }
  });

  return {
    tokens,

    start() {
      const loaded = credentials.load();
      if (loaded === null) {
        store.setState({ ...initialIdentityState });
        return;
      }
      cred = loaded;
      store.setState({ nickname: loaded.nickname, intent: 'active', onboardError: null });
      tokens.start(loaded);
      connectWhenIdle(loaded);
    },

    async onboard(raw) {
      const s = store.getState();
      if (s.creating || s.nickname !== null) return;
      const v = validateNickname(raw);
      if (!v.ok) {
        store.setState({ onboardError: v.error });
        return;
      }
      store.setState({ creating: true, onboardError: null });
      let r: ApiResult<CreatedSession>;
      try {
        r = await session.create(v.value);
      } catch {
        r = { ok: false, error: { kind: 'network' } };
      }
      if (disposed) return;
      if (!r.ok) {
        store.setState({ creating: false, onboardError: mapCreateError(r.error) });
        return;
      }
      const created = r.value;
      // D6: store the credential before connecting, so a crash after this point cannot orphan the account.
      const saved = credentials.save(created.credential);
      cred = created.credential;
      store.setState({
        nickname: created.credential.nickname,
        intent: 'active',
        remembered: saved.ok,
        creating: false,
        onboardError: null,
      });
      tokens.start(created.credential, { token: created.token, expiresIn: created.expiresIn });
      connectWhenIdle(created.credential);
    },

    continueSession() {
      if (cred === null) return;
      store.setState({ intent: 'active' });
      tokens.start(cred);
      connectWhenIdle(cred);
    },

    signOut() {
      cancelPending();
      tokens.stop();
      store.setState({ intent: 'signed-out' });
      client.disconnect();
    },

    startOver() {
      cancelPending();
      tokens.stop();
      const s = client.getState().status;
      if (s === 'connecting' || s === 'connected' || s === 'reconnecting') client.disconnect();
      // If clear() fails the next reload brings the old identity back; accepted and documented (ADR-019).
      credentials.clear();
      cred = null;
      store.setState({ ...initialIdentityState });
    },

    dispose() {
      disposed = true;
      cancelPending();
      unsubTokens();
      unsubClient();
      tokens.stop();
    },
  };
}
