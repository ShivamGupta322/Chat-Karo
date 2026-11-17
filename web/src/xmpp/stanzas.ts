import { xmlEl } from './xml';

export const NS_MUC = 'http://jabber.org/protocol/muc';
export const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
export const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';
export const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
export const NS_DELAY = 'urn:xmpp:delay';
export const NS_SID = 'urn:xmpp:sid:0';
export const NS_DATA = 'jabber:x:data';

export function buildPresence(): Element {
  return xmlEl('presence');
}

export function buildJoinPresence(roomJid: string, nick: string, maxStanzas: number): Element {
  return xmlEl('presence', { to: `${roomJid}/${nick}` }, [
    xmlEl('x', { xmlns: NS_MUC }, [xmlEl('history', { maxstanzas: String(maxStanzas) })]),
  ]);
}

export function buildLeavePresence(roomJid: string, nick: string): Element {
  return xmlEl('presence', { to: `${roomJid}/${nick}`, type: 'unavailable' });
}

export function buildGroupchat(roomJid: string, body: string, id: string): Element {
  return xmlEl('message', { to: roomJid, type: 'groupchat', id }, [xmlEl('body', {}, [body])]);
}

export function buildIqErrorReply(iq: Element): Element {
  const attrs: Record<string, string> = { type: 'error', id: iq.getAttribute('id') ?? '' };
  const from = iq.getAttribute('from');
  if (from !== null) attrs.to = from;
  return xmlEl('iq', attrs, [
    xmlEl('error', { type: 'cancel' }, [xmlEl('service-unavailable', { xmlns: NS_STANZAS })]),
  ]);
}

function kids(el: Element, localName: string, ns?: string): Element[] {
  return Array.from(el.children).filter(
    (c) => c.localName === localName && (ns === undefined || c.namespaceURI === ns),
  );
}

export function parseErrorCondition(el: Element): string {
  const err = kids(el, 'error')[0];
  if (!err) return 'undefined-condition';
  const cond = Array.from(err.children).find((c) => c.namespaceURI === NS_STANZAS);
  return cond ? cond.localName : 'undefined-condition';
}

export interface MucPresence {
  roomJid: string;
  nick: string;
  kind: 'available' | 'unavailable' | 'error';
  statusCodes: ReadonlySet<string>;
  errorCondition?: string;
}

function splitFrom(from: string): { bare: string; resource: string | null } {
  const i = from.indexOf('/');
  if (i < 0) return { bare: from, resource: null };
  const res = from.slice(i + 1);
  return { bare: from.slice(0, i), resource: res === '' ? null : res };
}

export function parseMucPresence(el: Element): MucPresence | null {
  if (el.localName !== 'presence') return null;
  const from = el.getAttribute('from');
  if (from === null) return null;
  const { bare, resource } = splitFrom(from);
  const type = el.getAttribute('type');
  const isError = type === 'error';
  if (resource === null && !isError) return null;
  if (type !== null && type !== 'unavailable' && !isError) return null;

  const codes = new Set<string>();
  // MongooseIM 6.2.1 sends self-presence codes (110/201) in the plain muc namespace, other
  // servers use muc#user. Accept both; ignore jabber:x:data and any other namespace.
  const xs = [...kids(el, 'x', NS_MUC_USER), ...kids(el, 'x', NS_MUC)];
  for (const x of xs) {
    for (const s of kids(x, 'status')) {
      const code = s.getAttribute('code');
      if (code !== null) codes.add(code);
    }
  }
  const result: MucPresence = {
    roomJid: bare,
    nick: resource ?? '',
    kind: isError ? 'error' : type === 'unavailable' ? 'unavailable' : 'available',
    statusCodes: codes,
  };
  if (isError) result.errorCondition = parseErrorCondition(el);
  return result;
}

export interface ParsedGroupchat {
  roomJid: string;
  nick: string | null;
  body: string;
  id: string | null;
  stanzaId: string | null;
  delayedAt: number | null;
}

export function parseGroupchat(el: Element): ParsedGroupchat | null {
  if (el.localName !== 'message' || el.getAttribute('type') !== 'groupchat') return null;
  const from = el.getAttribute('from');
  if (from === null) return null;
  const bodyEl = kids(el, 'body')[0];
  const body = bodyEl?.textContent ?? '';
  if (body.trim() === '') return null;
  const { bare, resource } = splitFrom(from);

  let stanzaId: string | null = null;
  for (const s of kids(el, 'stanza-id', NS_SID)) {
    const id = s.getAttribute('id');
    if (s.getAttribute('by') === bare && id !== null && id !== '') {
      stanzaId = id;
      break;
    }
  }

  let delayedAt: number | null = null;
  const delay = kids(el, 'delay', NS_DELAY)[0];
  const stamp = delay?.getAttribute('stamp');
  if (stamp) {
    const t = Date.parse(stamp);
    if (!Number.isNaN(t)) delayedAt = t;
  }

  return { roomJid: bare, nick: resource, body, id: el.getAttribute('id'), stanzaId, delayedAt };
}

export const NS_PING = 'urn:xmpp:ping';

export function buildPing(to: string, id: string): Element {
  return xmlEl('iq', { type: 'get', to, id }, [xmlEl('ping', { xmlns: NS_PING })]);
}

export function isPingRequest(el: Element): boolean {
  return (
    el.localName === 'iq' &&
    el.getAttribute('type') === 'get' &&
    kids(el, 'ping', NS_PING).length > 0
  );
}

export function buildIqResult(iq: Element): Element {
  const attrs: Record<string, string> = { type: 'result', id: iq.getAttribute('id') ?? '' };
  const from = iq.getAttribute('from');
  if (from !== null) attrs.to = from;
  return xmlEl('iq', attrs);
}
