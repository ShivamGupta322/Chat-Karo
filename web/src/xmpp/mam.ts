// XEP-0313 (MAM v2) for MUC rooms: pure builders/parsers, no Strophe. Never log what these handle.
import { NS_DATA, NS_DELAY, parseGroupchat } from './stanzas';
import { xmlEl } from './xml';

export const NS_MAM = 'urn:xmpp:mam:2';
export const NS_RSM = 'http://jabber.org/protocol/rsm';
export const NS_FORWARD = 'urn:xmpp:forward:0';

export interface MamQuery {
  roomJid: string;
  iqId: string;
  queryId: string;
  startIso: string;
  max: number;
  /** before: true = newest page; before: id = page ending just before id; after: id = page starting just after id */
  page: { before: true } | { before: string } | { after: string };
}

export interface MamItem {
  id: string;
  nick: string | null;
  body: string;
  sentAt: number;
}

function kids(el: Element, localName: string, ns: string): Element[] {
  return Array.from(el.children).filter(
    (c) => c.localName === localName && c.namespaceURI === ns,
  );
}

function bareOf(jid: string): { bare: string; resource: string | null } {
  const i = jid.indexOf('/');
  if (i < 0) return { bare: jid, resource: null };
  const res = jid.slice(i + 1);
  return { bare: jid.slice(0, i), resource: res === '' ? null : res };
}

export function buildMamQuery(q: MamQuery): Element {
  const rsm = [xmlEl('max', {}, [String(q.max)])];
  if ('after' in q.page) {
    rsm.push(xmlEl('after', {}, [q.page.after]));
  } else if (q.page.before === true) {
    rsm.push(xmlEl('before'));
  } else {
    rsm.push(xmlEl('before', {}, [q.page.before]));
  }
  return xmlEl('iq', { type: 'set', to: q.roomJid, id: q.iqId }, [
    xmlEl('query', { xmlns: NS_MAM, queryid: q.queryId }, [
      xmlEl('x', { xmlns: NS_DATA, type: 'submit' }, [
        xmlEl('field', { var: 'FORM_TYPE', type: 'hidden' }, [xmlEl('value', {}, [NS_MAM])]),
        xmlEl('field', { var: 'start' }, [xmlEl('value', {}, [q.startIso])]),
      ]),
      xmlEl('set', { xmlns: NS_RSM }, rsm),
    ]),
  ]);
}

export function isMamResultMessage(el: Element): boolean {
  return el.localName === 'message' && kids(el, 'result', NS_MAM).length > 0;
}

export function parseMamResult(
  el: Element,
  expect: { roomJid: string; queryId: string; notBefore: number },
): MamItem | null {
  if (el.localName !== 'message') return null;
  if (el.getAttribute('from') !== expect.roomJid) return null;
  const result = kids(el, 'result', NS_MAM)[0];
  if (!result) return null;
  if (result.getAttribute('queryid') !== expect.queryId) return null;
  const id = result.getAttribute('id');
  if (id === null || id === '') return null;
  const forwarded = kids(result, 'forwarded', NS_FORWARD)[0];
  if (!forwarded) return null;
  const stamp = kids(forwarded, 'delay', NS_DELAY)[0]?.getAttribute('stamp');
  if (!stamp) return null;
  const sentAt = Date.parse(stamp);
  if (Number.isNaN(sentAt) || sentAt < expect.notBefore) return null;
  const inner = Array.from(forwarded.children).find((c) => c.localName === 'message');
  if (!inner) return null;
  const m = parseGroupchat(inner);
  if (!m) return null;
  const from = inner.getAttribute('from');
  if (from === null) return null;
  const { bare, resource } = bareOf(from);
  if (bare !== expect.roomJid) return null;
  return { id, nick: resource, body: m.body, sentAt };
}

function textOrNull(el: Element | undefined): string | null {
  const t = el?.textContent ?? '';
  return t === '' ? null : t;
}

export function parseMamFin(
  iq: Element,
): { complete: boolean; first: string | null; last: string | null } | null {
  const fin = kids(iq, 'fin', NS_MAM)[0];
  if (!fin) return null;
  const c = fin.getAttribute('complete');
  const set = kids(fin, 'set', NS_RSM)[0];
  return {
    complete: c === 'true' || c === '1',
    first: set ? textOrNull(kids(set, 'first', NS_RSM)[0]) : null,
    last: set ? textOrNull(kids(set, 'last', NS_RSM)[0]) : null,
  };
}
