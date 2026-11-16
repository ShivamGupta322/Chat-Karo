// TEMPORARY (Phase 3 MUC lock-down): clients will no longer create rooms. Delete this file and its single call site in client.ts.
import type { IqResult, XmppTransport } from './transport';
import { NS_DATA, NS_MUC_OWNER } from './stanzas';
import { xmlEl } from './xml';

export function buildInstantRoomConfig(roomJid: string, id: string): Element {
  return xmlEl('iq', { to: roomJid, type: 'set', id }, [
    xmlEl('query', { xmlns: NS_MUC_OWNER }, [xmlEl('x', { xmlns: NS_DATA, type: 'submit' })]),
  ]);
}

export function acceptInstantRoom(
  transport: XmppTransport,
  roomJid: string,
  timeoutMs: number,
): Promise<IqResult> {
  return transport.sendIQ(buildInstantRoomConfig(roomJid, crypto.randomUUID()), timeoutMs);
}
