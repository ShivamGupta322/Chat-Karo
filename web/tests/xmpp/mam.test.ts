import { describe, expect, it } from 'vitest';
import {
  NS_FORWARD,
  NS_MAM,
  NS_RSM,
  buildMamQuery,
  isMamResultMessage,
  parseMamFin,
  parseMamResult,
} from '../../src/xmpp/mam';
import {
  CAPTURED_ROOM,
  MAM_FIN_COMPLETE,
  MAM_STAMP,
  mamResult,
  parse,
} from '../fixtures/stanzas';

const expectOk = { roomJid: CAPTURED_ROOM, queryId: 'q1', notBefore: 0 };

describe('buildMamQuery', () => {
  const base = {
    roomJid: CAPTURED_ROOM,
    iqId: 'iq1',
    queryId: 'q1',
    startIso: '2026-11-17T15:00:00.000Z',
    max: 50,
  };

  it('builds the iq, query and submit form', () => {
    const iq = buildMamQuery({ ...base, page: { before: true } });
    expect(iq.localName).toBe('iq');
    expect(iq.getAttribute('type')).toBe('set');
    expect(iq.getAttribute('to')).toBe(CAPTURED_ROOM);
    expect(iq.getAttribute('id')).toBe('iq1');
    const query = iq.firstElementChild;
    expect(query?.localName).toBe('query');
    expect(query?.namespaceURI).toBe(NS_MAM);
    expect(query?.getAttribute('queryid')).toBe('q1');
    const form = query?.firstElementChild;
    expect(form?.namespaceURI).toBe('jabber:x:data');
    expect(form?.getAttribute('type')).toBe('submit');
    const fields = Array.from(form?.children ?? []);
    expect(fields[0]?.getAttribute('var')).toBe('FORM_TYPE');
    expect(fields[0]?.getAttribute('type')).toBe('hidden');
    expect(fields[0]?.textContent).toBe(NS_MAM);
    expect(fields[1]?.getAttribute('var')).toBe('start');
    expect(fields[1]?.textContent).toBe(base.startIso);
  });

  it('asks for the last page with an empty <before/>', () => {
    const iq = buildMamQuery({ ...base, page: { before: true } });
    const set = iq.querySelector('set');
    expect(set?.namespaceURI).toBe(NS_RSM);
    expect(set?.querySelector('max')?.textContent).toBe('50');
    const before = set?.querySelector('before');
    expect(before?.namespaceURI).toBe(NS_RSM);
    expect(before?.textContent).toBe('');
    expect(set?.querySelector('after')).toBeNull();
  });

  it('pages forward with <after>ID</after> and no <before/>', () => {
    const iq = buildMamQuery({ ...base, page: { after: 'S1' } });
    const set = iq.querySelector('set');
    expect(set?.querySelector('after')?.textContent).toBe('S1');
    expect(set?.querySelector('after')?.namespaceURI).toBe(NS_RSM);
    expect(set?.querySelector('before')).toBeNull();
  });

  it('escapes special characters so they round-trip', () => {
    const nasty = `<&'"`;
    const iq = buildMamQuery({ ...base, queryId: nasty, page: { after: nasty } });
    // Built as DOM nodes (never string concatenation), so values stay literal and the serializer escapes them.
    expect(iq.querySelector('query')?.getAttribute('queryid')).toBe(nasty);
    expect(iq.querySelector('after')?.textContent).toBe(nasty);
    expect(iq.querySelectorAll('query *').length).toBe(8);
  });
});

describe('isMamResultMessage', () => {
  it('is true for a message with a mam:2 result', () => {
    expect(isMamResultMessage(mamResult())).toBe(true);
  });

  it('is false for a plain message, another namespace, or a non-message', () => {
    expect(
      isMamResultMessage(parse("<message from='a@b' type='groupchat'><body>hi</body></message>")),
    ).toBe(false);
    expect(
      isMamResultMessage(
        parse("<message><result xmlns='urn:xmpp:mam:1' queryid='q1' id='x'/></message>"),
      ),
    ).toBe(false);
    expect(isMamResultMessage(MAM_FIN_COMPLETE)).toBe(false);
  });
});

function wrap(forwardedInner: string, forwardedNs = NS_FORWARD): Element {
  return parse(
    `<message from='${CAPTURED_ROOM}'><result xmlns='urn:xmpp:mam:2' queryid='q1' id='x'><forwarded xmlns='${forwardedNs}'>${forwardedInner}</forwarded></result></message>`,
  );
}

const DELAY = `<delay xmlns='urn:xmpp:delay' stamp='${MAM_STAMP}'/>`;
const inner = (from: string, type: string, body: string): string =>
  `<message from='${from}' type='${type}'><body>${body}</body></message>`;

describe('parseMamResult', () => {
  it('parses the captured shape', () => {
    expect(parseMamResult(mamResult(), expectOk)).toEqual({
      id: 'CO4EUIA5RT81',
      nick: 'bob',
      body: 'hello from history',
      sentAt: Date.parse(MAM_STAMP),
    });
  });

  it('gives nick null for a message from the room itself', () => {
    const el = mamResult({ inner: inner(CAPTURED_ROOM, 'groupchat', 'Room is now open') });
    expect(parseMamResult(el, expectOk)?.nick).toBeNull();
  });

  it('accepts a stamp exactly at notBefore', () => {
    const t = Date.parse(MAM_STAMP);
    expect(parseMamResult(mamResult(), { ...expectOk, notBefore: t })).not.toBeNull();
  });

  const bob = `${CAPTURED_ROOM}/bob`;
  const strict = { ...expectOk, notBefore: Date.parse('2026-11-17T00:00:00Z') };

  it.each<[string, Element]>([
    ['outer from with a resource', mamResult({ from: `${CAPTURED_ROOM}/mallory` })],
    ['outer from of another room', mamResult({ from: 'other@muc.chaterl.localhost' })],
    [
      'outer from missing',
      parse(
        `<message><result xmlns='urn:xmpp:mam:2' queryid='q1' id='x'><forwarded xmlns='${NS_FORWARD}'>${DELAY}${inner(bob, 'groupchat', 'x')}</forwarded></result></message>`,
      ),
    ],
    ['wrong queryid', mamResult({ queryId: 'other' })],
    ['empty result id', mamResult({ id: '' })],
    [
      'missing result id',
      parse(
        `<message from='${CAPTURED_ROOM}'><result xmlns='urn:xmpp:mam:2' queryid='q1'><forwarded xmlns='${NS_FORWARD}'>${DELAY}${inner(bob, 'groupchat', 'x')}</forwarded></result></message>`,
      ),
    ],
    [
      'no forwarded',
      parse(
        `<message from='${CAPTURED_ROOM}'><result xmlns='urn:xmpp:mam:2' queryid='q1' id='x'/></message>`,
      ),
    ],
    ['forwarded in the wrong namespace', wrap(DELAY + inner(bob, 'groupchat', 'x'), 'urn:other')],
    ['no delay', wrap(inner(bob, 'groupchat', 'x'))],
    ['unparseable stamp', mamResult({ stamp: 'not-a-date' })],
    ['stamp before notBefore (legacy 1970 row)', mamResult({ stamp: '1970-01-01T00:00:01Z' })],
    ['inner chat type', mamResult({ inner: inner(bob, 'chat', 'x') })],
    [
      'inner from another room',
      mamResult({ inner: inner('other@muc.chaterl.localhost/bob', 'groupchat', 'x') }),
    ],
    ['empty body', mamResult({ inner: inner(bob, 'groupchat', '') })],
    ['whitespace body', mamResult({ inner: inner(bob, 'groupchat', '   ') })],
    [
      'subject only',
      mamResult({
        inner: `<message from='${CAPTURED_ROOM}' type='groupchat'><subject>topic</subject></message>`,
      }),
    ],
    [
      'wrong mam namespace',
      parse(
        `<message from='${CAPTURED_ROOM}'><result xmlns='urn:xmpp:mam:1' queryid='q1' id='x'><forwarded xmlns='${NS_FORWARD}'>${DELAY}${inner(bob, 'groupchat', 'x')}</forwarded></result></message>`,
      ),
    ],
  ])('returns null for %s', (_name, el) => {
    expect(parseMamResult(el, strict)).toBeNull();
  });
});

describe('parseMamFin', () => {
  const fin = (attrs: string, children = ''): Element =>
    parse(`<iq type='result'><fin xmlns='urn:xmpp:mam:2'${attrs}>${children}</fin></iq>`);

  it('reads complete, first and last from the captured shape', () => {
    expect(parseMamFin(MAM_FIN_COMPLETE)).toEqual({
      complete: true,
      first: 'CO4EUIA5RT81',
      last: 'CO4EUIA5RT82',
    });
  });

  it("treats complete='1' as complete and an absent attribute as incomplete", () => {
    expect(parseMamFin(fin(" complete='1'"))?.complete).toBe(true);
    expect(parseMamFin(fin(''))?.complete).toBe(false);
    expect(parseMamFin(fin(" complete='false'"))?.complete).toBe(false);
  });

  it('returns nulls for first/last when the set is missing or empty', () => {
    expect(parseMamFin(fin(''))).toEqual({ complete: false, first: null, last: null });
    expect(
      parseMamFin(fin('', `<set xmlns='${NS_RSM}'><first/><last></last></set>`)),
    ).toEqual({ complete: false, first: null, last: null });
  });

  it('returns null when there is no fin', () => {
    expect(parseMamFin(parse("<iq type='result'/>"))).toBeNull();
    expect(parseMamFin(parse("<iq type='result'><fin xmlns='urn:xmpp:mam:1'/></iq>"))).toBeNull();
  });
});
