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
