export type TransportStatus =
  | { kind: 'connecting' }
  | { kind: 'connected'; jid: string }
  | { kind: 'disconnecting' }
  | { kind: 'disconnected' }
  | {
      kind: 'failed';
      reason: 'auth-failed' | 'connection-failed' | 'error';
      condition?: string;
    };

export type IqResult = { ok: true; stanza: Element } | { ok: false; condition: string };

export interface XmppTransport {
  connect(jid: string, password: string, onStatus: (s: TransportStatus) => void): void;
  disconnect(reason: string): void;
  send(stanza: Element): void;
  /** Never rejects; 'timeout' condition on timeout. */
  sendIQ(iq: Element, timeoutMs: number): Promise<IqResult>;
  /** Handlers persist across connects. */
  onStanza(handler: (stanza: Element) => void): () => void;
}
