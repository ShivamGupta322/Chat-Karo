export function parse(xml: string): Element {
  return new DOMParser().parseFromString(xml, 'text/xml').documentElement;
}

const MUC_USER = 'http://jabber.org/protocol/muc#user';
const STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';

export const ROOM = 'lobby@muc.chaterl.localhost';

export function presence(nick: string, codes: string[] = [], type?: string): Element {
  const t = type ? ` type="${type}"` : '';
  const st = codes.map((c) => `<status code="${c}"/>`).join('');
  return parse(
    `<presence from="${ROOM}/${nick}" to="alice@chaterl.localhost/r"${t}><x xmlns="${MUC_USER}"><item affiliation="member" role="participant"/>${st}</x></presence>`,
  );
}

export function presenceError(condition: string, room = ROOM): Element {
  return parse(
    `<presence from="${room}/alice" type="error"><error type="cancel"><${condition} xmlns="${STANZAS}"/></error></presence>`,
  );
}

export function groupchat(nick: string | null, body: string, extra = '', id = 'm1'): Element {
  const from = nick === null ? ROOM : `${ROOM}/${nick}`;
  return parse(
    `<message from="${from}" type="groupchat" id="${id}"><body>${body}</body>${extra}</message>`,
  );
}

// Frames captured from MongooseIM 6.2.1. Self-presence codes arrive in the PLAIN muc namespace.
export const CAPTURED_ROOM = 'test2@muc.chaterl.localhost';
export const CAPTURED_SELF_201 = parse(
  "<presence from='test2@muc.chaterl.localhost/alice' to='alice@chaterl.localhost/1794-851070-904439-0d542a5db3522fe4' xmlns='jabber:client'><x xmlns='http://jabber.org/protocol/muc'><item jid='alice@chaterl.localhost/1794-851070-904439-0d542a5db3522fe4' affiliation='owner' role='moderator'/><status code='110'/><status code='201'/></x></presence>",
);
export const CAPTURED_LEAVE = parse(
  "<presence from='test1@muc.chaterl.localhost/alice' to='alice@chaterl.localhost/1794-851070-904439-0d542a5db3522fe4' type='unavailable' xmlns='jabber:client'><x xmlns='http://jabber.org/protocol/muc'><item affiliation='owner' role='none'/><status code='110'/></x></presence>",
);
export const CAPTURED_SUBJECT = parse(
  "<message from='test2@muc.chaterl.localhost' to='alice@chaterl.localhost/1794-851070-904439-0d542a5db3522fe4' type='groupchat' xmlns='jabber:client'><subject/><body/></message>",
);
export const CAPTURED_ERROR = parse(
  "<message from='test1@muc.chaterl.localhost' to='alice@chaterl.localhost/1794-851070-904439-0d542a5db3522fe4' type='error' id='5265cec6-4d78-487f-9b78-3cb62e347b6c' xmlns='jabber:client'><body>second try</body><error code='404' type='cancel'><item-not-found xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/><text xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>This room is locked</text></error></message>",
);

// MAM v2 shapes as MongooseIM 6.2.1 returns them for a MUC archive query.
export const MAM_STAMP = '2026-11-18T15:49:25.250549Z';

export function mamResult(
  opts: {
    queryId?: string;
    id?: string;
    stamp?: string;
    from?: string;
    inner?: string;
  } = {},
): Element {
  const {
    queryId = 'q1',
    id = 'CO4EUIA5RT81',
    stamp = MAM_STAMP,
    from = CAPTURED_ROOM,
    inner = `<message from='${CAPTURED_ROOM}/bob' type='groupchat' xmlns='jabber:client'><body>hello from history</body><x xmlns='http://jabber.org/protocol/muc#user'><item jid='bob@chaterl.localhost' affiliation='member' role='participant'/></x></message>`,
  } = opts;
  return parse(
    `<message from='${from}' to='alice@chaterl.localhost/r1' xmlns='jabber:client'><result xmlns='urn:xmpp:mam:2' queryid='${queryId}' id='${id}'><forwarded xmlns='urn:xmpp:forward:0'><delay xmlns='urn:xmpp:delay' stamp='${stamp}'/>${inner}</forwarded></result></message>`,
  );
}

export const MAM_FIN_COMPLETE = parse(
  "<iq from='test2@muc.chaterl.localhost' to='alice@chaterl.localhost/r1' id='iq1' type='result' xmlns='jabber:client'><fin xmlns='urn:xmpp:mam:2' complete='true'><set xmlns='http://jabber.org/protocol/rsm'><first index='0'>CO4EUIA5RT81</first><last>CO4EUIA5RT82</last><count>2</count></set></fin></iq>",
);

export const MAM_ERROR_ITEM_NOT_FOUND = parse(
  "<iq from='test2@muc.chaterl.localhost' to='alice@chaterl.localhost/r1' id='iq1' type='error' xmlns='jabber:client'><error type='cancel'><item-not-found xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>",
);
