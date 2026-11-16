import type { IqResult, TransportStatus, XmppTransport } from '../../src/xmpp/transport';

export interface FakeTransport extends XmppTransport {
  sent: Element[];
  iqs: Element[];
  connectCalls: { jid: string; password: string }[];
  disconnectCalls: string[];
  pushStatus(s: TransportStatus): void;
  pushStanza(el: Element): void;
  resolveIq(index: number, result: IqResult): void;
  /** The names of the sent elements, e.g. ['presence', 'message'] */
  sentNames(): string[];
}

export function createFakeTransport(): FakeTransport {
  const handlers = new Set<(el: Element) => void>();
  const pending: ((r: IqResult) => void)[] = [];
  let onStatus: ((s: TransportStatus) => void) | null = null;
  const t: FakeTransport = {
    sent: [],
    iqs: [],
    connectCalls: [],
    disconnectCalls: [],
    connect(jid, password, cb) {
      t.connectCalls.push({ jid, password });
      onStatus = cb;
    },
    disconnect(reason) {
      t.disconnectCalls.push(reason);
    },
    send(el) {
      t.sent.push(el);
    },
    sendIQ(iq) {
      t.iqs.push(iq);
      return new Promise<IqResult>((resolve) => {
        pending.push(resolve);
      });
    },
    onStanza(h) {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
    pushStatus(s) {
      onStatus?.(s);
    },
    pushStanza(el) {
      for (const h of [...handlers]) h(el);
    },
    resolveIq(index, result) {
      pending[index]?.(result);
    },
    sentNames() {
      return t.sent.map((e) => e.localName);
    },
  };
  return t;
}
