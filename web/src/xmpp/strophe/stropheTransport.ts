// The ONLY file in the app that imports strophe.js (enforced by ESLint no-restricted-imports).
import { Strophe } from 'strophe.js';
import type { IqResult, TransportStatus, XmppTransport } from '../transport';

function mapStatus(status: number, condition: string | null | undefined): TransportStatus | null {
  const S = Strophe.Status;
  switch (status) {
    case S.CONNECTING:
    case S.AUTHENTICATING:
      return { kind: 'connecting' };
    case S.DISCONNECTING:
      return { kind: 'disconnecting' };
    case S.DISCONNECTED:
      return { kind: 'disconnected' };
    case S.AUTHFAIL:
      return { kind: 'failed', reason: 'auth-failed' };
    case S.CONNFAIL:
    case S.CONNTIMEOUT:
      return condition
        ? { kind: 'failed', reason: 'connection-failed', condition }
        : { kind: 'failed', reason: 'connection-failed' };
    case S.ERROR:
      return { kind: 'failed', reason: 'error' };
    default:
      return null;
  }
}

function errorCondition(stanza: Element | null): string {
  if (!stanza) return 'timeout';
  const err = Array.from(stanza.children).find((c) => c.localName === 'error');
  const cond = err
    ? Array.from(err.children).find(
        (c) => c.namespaceURI === 'urn:ietf:params:xml:ns:xmpp-stanzas',
      )
    : undefined;
  return cond ? cond.localName : 'undefined-condition';
}

// Official API: drop the DEBUG/INFO console noise (does not touch Strophe.log).
// The d.ts types the constant as number but the parameter as a literal union, hence the cast.
Strophe.setLogLevel(Strophe.LogLevel.WARN as Parameters<typeof Strophe.setLogLevel>[0]);

export function createStropheTransport(wsUrl: string): XmppTransport {
  const listeners = new Set<(stanza: Element) => void>();
  let conn: InstanceType<typeof Strophe.Connection> | null = null;

  // Strophe removes any handler that throws or returns a falsy value, so never throw and
  // always return true. Never log the stanza itself (may contain message bodies).
  const dispatch = (stanza: Element): boolean => {
    for (const l of [...listeners]) {
      try {
        l(stanza);
      } catch (err) {
        console.error('xmpp handler error', err instanceof Error ? err.name : 'unknown');
      }
    }
    return true;
  };

  return {
    connect(jid, password, onStatus) {
      // Close any previous socket (e.g. after a failed login) so it cannot leak; its late
      // callbacks are dropped because it is no longer the current connection.
      const previous = conn;
      conn = null;
      previous?.disconnect('replaced');
      const c = new Strophe.Connection(wsUrl);
      conn = c;
      c.connect(jid, password, (status: number, condition?: string | null) => {
        if (c !== conn) return;
        if (status === Strophe.Status.CONNECTED) {
          // Strophe clears handlers on connect/reset, so register on every CONNECTED.
          // null ns/name/type/id/from = match everything (Strophe's documented wildcard).
          c.addHandler(
            dispatch,
            null as unknown as string,
            null as unknown as string,
            null as unknown as string,
          );
          onStatus({ kind: 'connected', jid: c.jid });
          return;
        }
        const mapped = mapStatus(status, condition);
        if (mapped) onStatus(mapped);
        if (mapped?.kind === 'failed') {
          // Strophe leaves the socket open after AUTHFAIL/CONNFAIL/ERROR; close it ourselves.
          c.disconnect(mapped.reason);
        }
      });
    },

    disconnect(reason) {
      conn?.disconnect(reason);
    },

    send(stanza) {
      conn?.send(stanza);
    },

    sendIQ(iq, timeoutMs) {
      return new Promise<IqResult>((resolve) => {
        const c = conn;
        if (!c) {
          resolve({ ok: false, condition: 'not-connected' });
          return;
        }
        try {
          c.sendIQ(
            iq,
            (stanza: Element) => resolve({ ok: true, stanza }),
            (stanza: Element | null) => resolve({ ok: false, condition: errorCondition(stanza) }),
            timeoutMs,
          );
        } catch (err) {
          console.error('xmpp sendIQ error', err instanceof Error ? err.name : 'unknown');
          resolve({ ok: false, condition: 'error' });
        }
      });
    },

    onStanza(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
