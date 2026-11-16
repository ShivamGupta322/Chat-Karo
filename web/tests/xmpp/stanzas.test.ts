import { describe, expect, it } from 'vitest';
import {
  buildGroupchat,
  buildIqErrorReply,
  buildJoinPresence,
  buildLeavePresence,
  parseErrorCondition,
  parseGroupchat,
  parseMucPresence,
} from '../../src/xmpp/stanzas';
import { buildInstantRoomConfig } from '../../src/xmpp/roomCreation';
import {
  CAPTURED_LEAVE,
  CAPTURED_SELF_201,
  CAPTURED_SUBJECT,
  ROOM,
  groupchat,
  parse,
  presence,
  presenceError,
} from '../fixtures/stanzas';

describe('builders', () => {
  it('join presence', () => {
    const el = buildJoinPresence(ROOM, 'alice', 20);
    expect(el.localName).toBe('presence');
    expect(el.getAttribute('to')).toBe(`${ROOM}/alice`);
    const x = el.firstElementChild;
    expect(x?.namespaceURI).toBe('http://jabber.org/protocol/muc');
    expect(x?.firstElementChild?.getAttribute('maxstanzas')).toBe('20');
  });
  it('leave presence', () => {
    const el = buildLeavePresence(ROOM, 'alice');
    expect(el.getAttribute('type')).toBe('unavailable');
    expect(el.getAttribute('to')).toBe(`${ROOM}/alice`);
  });
  it('groupchat escapes the body', () => {
    const el = buildGroupchat(ROOM, '<b>&"', 'id1');
    expect(el.getAttribute('type')).toBe('groupchat');
    expect(el.getAttribute('id')).toBe('id1');
    const xml = new XMLSerializer().serializeToString(el);
    expect(xml).not.toContain('<b>');
    expect(parse(xml).querySelector('body')?.textContent).toBe('<b>&"');
  });
  it('instant room config', () => {
    const el = buildInstantRoomConfig(ROOM, 'c1');
    expect(el.getAttribute('type')).toBe('set');
    const q = el.firstElementChild;
    expect(q?.namespaceURI).toBe('http://jabber.org/protocol/muc#owner');
    expect(q?.firstElementChild?.getAttribute('type')).toBe('submit');
  });
  it('iq error reply swaps addresses and keeps id', () => {
    const r = buildIqErrorReply(
      parse('<iq from="a@b/c" to="x@y" type="get" id="q1"><ping xmlns="urn:xmpp:ping"/></iq>'),
    );
    expect(r.getAttribute('to')).toBe('a@b/c');
    expect(r.getAttribute('id')).toBe('q1');
    expect(r.getAttribute('type')).toBe('error');
    expect(r.querySelector('service-unavailable')).not.toBeNull();
  });
});

describe('parseGroupchat', () => {
  it('parses a live message', () => {
    const m = parseGroupchat(groupchat('bob', 'hi'));
    expect(m).toMatchObject({ roomJid: ROOM, nick: 'bob', body: 'hi', id: 'm1', delayedAt: null });
  });
  it('reads a valid delay stamp', () => {
    const m = parseGroupchat(
      groupchat('bob', 'hi', '<delay xmlns="urn:xmpp:delay" stamp="2024-01-02T03:04:05Z"/>'),
    );
    expect(m?.delayedAt).toBe(Date.parse('2024-01-02T03:04:05Z'));
  });
  it('ignores an invalid stamp', () => {
    const m = parseGroupchat(
      groupchat('bob', 'hi', '<delay xmlns="urn:xmpp:delay" stamp="nope"/>'),
    );
    expect(m?.delayedAt).toBeNull();
  });
  it('room-originated has nick null', () => {
    expect(parseGroupchat(groupchat(null, 'welcome'))?.nick).toBeNull();
  });
  it('subject-only is null', () => {
    expect(
      parseGroupchat(
        parse(`<message from="${ROOM}" type="groupchat"><subject>x</subject></message>`),
      ),
    ).toBeNull();
  });
  it('empty/whitespace body is null', () => {
    expect(parseGroupchat(groupchat('bob', ''))).toBeNull();
    expect(parseGroupchat(groupchat('bob', '   '))).toBeNull();
  });
  it('type=chat is null', () => {
    expect(
      parseGroupchat(parse(`<message from="${ROOM}/bob" type="chat"><body>x</body></message>`)),
    ).toBeNull();
  });
  it('uses stanza-id by the room', () => {
    const m = parseGroupchat(
      groupchat('bob', 'hi', `<stanza-id xmlns="urn:xmpp:sid:0" id="S1" by="${ROOM}"/>`),
    );
    expect(m?.stanzaId).toBe('S1');
  });
  it('ignores stanza-id with a foreign by', () => {
    const m = parseGroupchat(
      groupchat('bob', 'hi', '<stanza-id xmlns="urn:xmpp:sid:0" id="S1" by="evil@x"/>'),
    );
    expect(m?.stanzaId).toBeNull();
  });
});

describe('parseMucPresence', () => {
  it('self with 110', () => {
    const p = parseMucPresence(presence('alice', ['110']));
    expect(p?.kind).toBe('available');
    expect(p?.nick).toBe('alice');
    expect(p?.statusCodes.has('110')).toBe(true);
  });
  it('110 + 201', () => {
    const p = parseMucPresence(presence('alice', ['110', '201']));
    expect([...(p?.statusCodes ?? [])].sort()).toEqual(['110', '201']);
  });
  it('110 + 210 server-assigned nick', () => {
    const p = parseMucPresence(presence('alice-1', ['110', '210']));
    expect(p?.nick).toBe('alice-1');
    expect(p?.statusCodes.has('210')).toBe(true);
  });
  it('unavailable with 307', () => {
    const p = parseMucPresence(presence('alice', ['110', '307'], 'unavailable'));
    expect(p?.kind).toBe('unavailable');
    expect(p?.statusCodes.has('307')).toBe(true);
  });
  it('error conflict', () => {
    const p = parseMucPresence(presenceError('conflict'));
    expect(p?.kind).toBe('error');
    expect(p?.errorCondition).toBe('conflict');
  });
  it('error registration-required', () => {
    expect(parseMucPresence(presenceError('registration-required'))?.errorCondition).toBe(
      'registration-required',
    );
  });
  it('does not read status inside a non-MUC x', () => {
    const el = parse(
      `<presence from="${ROOM}/bob"><x xmlns="jabber:x:data"><status code="110"/></x></presence>`,
    );
    expect(parseMucPresence(el)?.statusCodes.size).toBe(0);
  });
  it('non-MUC presence with bare from is null', () => {
    expect(parseMucPresence(parse('<presence from="bob@chaterl.localhost"/>'))).toBeNull();
  });
});

describe('captured MongooseIM frames', () => {
  it('reads 110 and 201 from the plain muc namespace', () => {
    const p = parseMucPresence(CAPTURED_SELF_201);
    expect([...(p?.statusCodes ?? [])].sort()).toEqual(['110', '201']);
    expect(p?.nick).toBe('alice');
  });
  it('reads 110 from an unavailable self presence in the plain muc namespace', () => {
    const p = parseMucPresence(CAPTURED_LEAVE);
    expect(p?.kind).toBe('unavailable');
    expect([...(p?.statusCodes ?? [])]).toEqual(['110']);
  });
  it('the room subject message still parses to null', () => {
    expect(parseGroupchat(CAPTURED_SUBJECT)).toBeNull();
  });
});

describe('parseErrorCondition', () => {
  it('defaults when <error> is missing', () => {
    expect(parseErrorCondition(parse('<message type="error"/>'))).toBe('undefined-condition');
  });
});
