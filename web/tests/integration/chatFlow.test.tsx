import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.useRealTimers();
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
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(t.connectCalls[0]?.jid).toBe('alice@chaterl.localhost');
    act(() => {
      t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    });
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    // 2. join
    await user.click(screen.getByRole('button', { name: 'Join' }));
    const join = t.sent.find((e) => e.getAttribute('to') === `${ROOM}/alice`);
    expect(join).toBeDefined();
    act(() => {
      t.pushStanza(presence('bob'));
      t.pushStanza(presence('alice', ['110']));
    });
    const occupants = await screen.findByRole('heading', { name: /People here/ });
    expect(occupants).toHaveTextContent(/People here.*2/);
    const section = occupants.closest('section');
    expect(section).not.toBeNull();
    if (section) {
      expect(within(section).getByText('bob')).toBeInTheDocument();
      expect(within(section).getByText('(you)', { exact: false })).toBeInTheDocument();
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

  function mount(): ReturnType<typeof createFakeTransport> {
    const t = createFakeTransport();
    const client = createXmppClient(t, {
      mucDomain: 'muc.chaterl.localhost',
      random: () => 0.5,
    });
    render(
      <XmppProvider client={client}>
        <App xmppDomain="chaterl.localhost" mucDomain="muc.chaterl.localhost" />
      </XmppProvider>,
    );
    return t;
  }

  async function signInAndJoin(
    t: ReturnType<typeof createFakeTransport>,
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    act(() => {
      t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r1' });
    });
    await user.click(await screen.findByRole('button', { name: 'Join' }));
    act(() => {
      t.pushStanza(presence('alice', ['110']));
    });
  }

  it('survives a dropped connection: banner, disabled composer, then rejoin keeps the timeline', async () => {
    const t = mount();
    const user = userEvent.setup({ delay: null });
    await signInAndJoin(t, user);
    act(() => {
      t.pushStanza(groupchat('bob', 'still here', '', 'm-keep'));
    });
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();

    vi.useFakeTimers();
    act(() => {
      t.pushStatus({ kind: 'disconnected' });
    });
    // Chat stays mounted (no bounce to the login form).
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByText('Connection lost.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try now' })).toBeInTheDocument();
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      t.pushStatus({ kind: 'connecting' });
      t.pushStatus({ kind: 'connected', jid: 'alice@chaterl.localhost/r2' });
    });
    act(() => {
      t.pushStanza(presence('alice', ['110']));
    });
    expect(screen.queryByText('Connection lost.')).toBeNull();
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(within(screen.getByRole('log')).getByText('still here')).toBeInTheDocument();
  }, 20_000);

  it('signing out while reconnecting shows the login form and the next session starts clean', async () => {
    const t = mount();
    const user = userEvent.setup({ delay: null });
    await signInAndJoin(t, user);
    act(() => {
      t.pushStanza(presence('carol'));
      t.pushStanza(groupchat('bob', 'old message', '', 'm-old'));
    });
    const log = screen.getByRole('log');
    expect(within(log).getByText('carol joined')).toBeInTheDocument();

    act(() => {
      t.pushStatus({ kind: 'disconnected' });
    });
    expect(screen.getByText('Connection lost.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(t.connectCalls).toHaveLength(1);

    await signInAndJoin(t, user);
    expect(screen.queryByText('carol joined')).toBeNull();
    expect(screen.queryByText('old message')).toBeNull();
  }, 20_000);
});
