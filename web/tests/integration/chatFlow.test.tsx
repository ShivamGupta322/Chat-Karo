import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { XmppProvider, createXmppClient } from '../../src/xmpp';
import { ROOM, groupchat, parse, presence } from '../fixtures/stanzas';
import { createFakeTransport } from '../helpers/fakeTransport';

describe('chat flow', () => {
  beforeEach(() => {
    useSessionStore.setState({ connection: { status: 'idle' } });
    useRoomStore.setState({ ...initialRoomState });
  });

  it('logs in, joins a room, sees occupants and sends a message', async () => {
    const t = createFakeTransport();
    const client = createXmppClient(t, { mucDomain: 'muc.chaterl.localhost' });
    const user = userEvent.setup({ delay: null });
    render(
      <XmppProvider client={client}>
        <App xmppDomain="chaterl.localhost" mucDomain="muc.chaterl.localhost" />
      </XmppProvider>,
    );

    // 1. log in
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(t.connectCalls[0]?.jid).toBe('alice@chaterl.localhost');
    act(() => {
      t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    });
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeInTheDocument();

    // 2. join
    await user.click(screen.getByRole('button', { name: 'Join' }));
    const join = t.sent.find((e) => e.getAttribute('to') === `${ROOM}/alice`);
    expect(join).toBeDefined();
    act(() => {
      t.pushStanza(presence('bob'));
      t.pushStanza(presence('alice', ['110']));
    });
    const occupants = await screen.findByRole('heading', { name: /Occupants/ });
    expect(occupants).toHaveTextContent('Occupants (2)');
    const section = occupants.closest('section');
    expect(section).not.toBeNull();
    if (section) {
      expect(within(section).getByText('bob')).toBeInTheDocument();
      expect(within(section).getByText('(you)')).toBeInTheDocument();
    }

    // 3. send and see the echo
    await user.type(screen.getByLabelText('Message'), 'hello world{Enter}');
    const sent = t.sent.at(-1);
    expect(sent?.getAttribute('type')).toBe('groupchat');
    expect(sent?.querySelector('body')?.textContent).toBe('hello world');
    expect(within(screen.getByRole('log')).queryByText('hello world')).toBeNull();
    act(() => {
      t.pushStanza(groupchat('alice', 'hello world', '', 'echo1'));
    });
    expect(within(screen.getByRole('log')).getByText('hello world')).toBeInTheDocument();

    // 4. a rejected message produces a notice (server text is not rendered)
    act(() => {
      t.pushStanza(
        parse(
          `<message from="${ROOM}" type="error" id="x"><body>again</body><error code="404" type="cancel"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/><text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">This room is locked</text></error></message>`,
        ),
      );
    });
    const log = screen.getByRole('log');
    expect(
      within(log).getByText('Message not delivered: the room is unavailable or locked'),
    ).toBeInTheDocument();
    expect(within(log).queryByText(/This room is locked/)).toBeNull();
    // Full UI flow; jsdom + userEvent can exceed the 5 s default on slower machines.
  }, 20_000);
});
