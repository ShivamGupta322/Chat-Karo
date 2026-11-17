import { beforeEach, describe, expect, it } from 'vitest';
import { bindXmppToStores } from '../../src/state/bindXmpp';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { createXmppClient } from '../../src/xmpp/client';
import { ROOM, presence } from '../fixtures/stanzas';
import { createFakeTransport } from '../helpers/fakeTransport';

describe('bindXmppToStores', () => {
  beforeEach(() => {
    useSessionStore.setState({ connection: { status: 'idle' } });
    useRoomStore.setState({ ...initialRoomState });
  });

  it('a terminal disconnect resets the room store and updates the session store', () => {
    const t = createFakeTransport();
    const client = createXmppClient(t, { mucDomain: 'muc.chaterl.localhost' });
    const off = bindXmppToStores(client);
    client.connect('alice@chaterl.localhost', 'pw');
    t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    client.joinRoom(ROOM, 'alice');
    t.pushStanza(presence('alice', ['110']));
    expect(useRoomStore.getState().status).toBe('joined');

    client.disconnect();
    t.pushStatus({ kind: 'disconnected' });

    expect(useSessionStore.getState().connection).toEqual({ status: 'disconnected' });
    const room = useRoomStore.getState();
    expect(room.roomJid).toBeNull();
    expect(room.status).toBe('none');
    expect(room.timeline).toEqual([]);
    off();
  });

  it('a drop keeps the room store and marks the room as reconnecting', () => {
    const t = createFakeTransport();
    const client = createXmppClient(t, { mucDomain: 'muc.chaterl.localhost' });
    const off = bindXmppToStores(client);
    client.connect('alice@chaterl.localhost', 'pw');
    t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    client.joinRoom(ROOM, 'alice');
    t.pushStanza(presence('alice', ['110']));

    t.pushStatus({ kind: 'disconnected' });

    expect(useSessionStore.getState().connection.status).toBe('reconnecting');
    expect(useRoomStore.getState().status).toBe('reconnecting');
    expect(useRoomStore.getState().roomJid).toBe(ROOM);
    off();
  });
});
