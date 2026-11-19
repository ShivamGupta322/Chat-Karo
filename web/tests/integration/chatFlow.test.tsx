import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { XmppProvider, createXmppClient } from '../../src/xmpp';
import { ROOM, groupchat, mamResult, parse, presence } from '../fixtures/stanzas';
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

  function mount(
    extra: Partial<Parameters<typeof createXmppClient>[1]> = {},
  ): ReturnType<typeof createFakeTransport> {
    const t = createFakeTransport();
    const client = createXmppClient(t, {
      mucDomain: 'muc.chaterl.localhost',
      random: () => 0.5,
      ...extra,
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

  describe('room history', () => {
    const recent = (): string => new Date(Date.now() - 3_600_000).toISOString();
    const finIq = (complete: boolean, last: string): Element =>
      parse(
        `<iq type="result"><fin xmlns="urn:xmpp:mam:2" complete="${String(complete)}"><set xmlns="http://jabber.org/protocol/rsm"><first index="0">${last}</first><last>${last}</last></set></fin></iq>`,
      );
    const queryIdOf = (t: ReturnType<typeof createFakeTransport>, i: number): string =>
      t.iqs[i]?.querySelector('query')?.getAttribute('queryid') ?? '';
    const pushResult = (
      t: ReturnType<typeof createFakeTransport>,
      i: number,
      id: string,
      nick: string,
      body: string,
    ): void => {
      act(() => {
        t.pushStanza(
          mamResult({
            queryId: queryIdOf(t, i),
            id,
            stamp: recent(),
            from: ROOM,
            inner: `<message from="${ROOM}/${nick}" type="groupchat"><body>${body}</body></message>`,
          }),
        );
      });
    };
    const answer = async (
      t: ReturnType<typeof createFakeTransport>,
      i: number,
      complete: boolean,
      last: string,
    ): Promise<void> => {
      await act(async () => {
        t.resolveIq(i, { ok: true, stanza: finIq(complete, last) });
        await Promise.resolve();
      });
    };

    it('shows the last messages from the archive with the divider, and de-dupes a later live copy', async () => {
      const t = mount();
      const user = userEvent.setup({ delay: null });
      await signInAndJoin(t, user);
      expect(t.iqs).toHaveLength(1);
      expect(screen.getByText('Loading recent messages…', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');

      pushResult(t, 0, 'H1', 'bob', 'first from history');
      pushResult(t, 0, 'H2', 'carol', 'second from history');
      await answer(t, 0, true, 'H2');

      const log = screen.getByRole('log');
      expect(within(log).getByText('first from history')).toBeInTheDocument();
      expect(within(log).getByText('second from history')).toBeInTheDocument();
      expect(within(log).getByRole('separator')).toBeInTheDocument();
      expect(log).not.toHaveAttribute('aria-busy');
      expect(screen.queryByText('Loading recent messages…')).toBeNull();

      act(() => {
        t.pushStanza(
          groupchat(
            'carol',
            'second from history',
            `<stanza-id xmlns="urn:xmpp:sid:0" id="H2" by="${ROOM}"/>`,
            'live-copy',
          ),
        );
      });
      expect(within(log).getAllByText('second from history')).toHaveLength(1);
    }, 20_000);

    it('shows a retry when history cannot load and asks again on "Try again"', async () => {
      const t = mount();
      const user = userEvent.setup({ delay: null });
      await signInAndJoin(t, user);
      await act(async () => {
        t.resolveIq(0, { ok: false, condition: 'resource-constraint' });
        await Promise.resolve();
      });
      expect(screen.getByText("Couldn't load recent messages.")).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      // The shared throttle may hold the retry back for up to 1.1 s.
      await vi.waitFor(
        () => {
          expect(t.iqs).toHaveLength(2);
        },
        { timeout: 3_000 },
      );
      expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
      expect(screen.getByText('Loading recent messages…', { selector: 'p' })).toBeInTheDocument();
    }, 20_000);

    it('after a reconnect, fetches only what was missed, forward from the last id, without duplicates', async () => {
      const t = mount();
      const user = userEvent.setup({ delay: null });
      await signInAndJoin(t, user);
      pushResult(t, 0, 'H1', 'bob', 'before the outage');
      await answer(t, 0, true, 'H1');

      vi.useFakeTimers();
      act(() => {
        t.pushStatus({ kind: 'disconnected' });
      });
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
      act(() => {
        vi.advanceTimersByTime(1_200);
      });
      expect(t.iqs).toHaveLength(2);
      const gap = t.iqs[1];
      expect(gap?.querySelector('after')?.textContent).toBe('H1');
      expect(gap?.querySelector('before')).toBeNull();

      pushResult(t, 1, 'H1', 'bob', 'before the outage');
      pushResult(t, 1, 'H3', 'carol', 'while you were away');
      await answer(t, 1, true, 'H3');

      const log = screen.getByRole('log');
      expect(within(log).getAllByText('before the outage')).toHaveLength(1);
      expect(within(log).getAllByText('while you were away')).toHaveLength(1);
    }, 20_000);

    describe('load earlier messages', () => {
      const rsmFin = (complete: boolean, first: string, last: string): Element =>
        parse(
          `<iq type="result"><fin xmlns="urn:xmpp:mam:2" complete="${String(complete)}"><set xmlns="http://jabber.org/protocol/rsm"><first index="0">${first}</first><last>${last}</last></set></fin></iq>`,
        );
      const answerRsm = async (
        t: ReturnType<typeof createFakeTransport>,
        i: number,
        complete: boolean,
        first: string,
        last: string,
      ): Promise<void> => {
        await act(async () => {
          t.resolveIq(i, { ok: true, stanza: rsmFin(complete, first, last) });
          await Promise.resolve();
        });
      };
      const BUTTON = { name: 'Load earlier messages' };

      async function reachIncompleteHistory(): Promise<{
        t: ReturnType<typeof createFakeTransport>;
        user: ReturnType<typeof userEvent.setup>;
      }> {
        const t = mount({ mamPageSize: 2 });
        const user = userEvent.setup({ delay: null });
        await signInAndJoin(t, user);
        expect(screen.queryByRole('button', BUTTON)).toBeNull();
        pushResult(t, 0, 'H3', 'bob', 'body H3');
        pushResult(t, 0, 'H4', 'bob', 'body H4');
        await answerRsm(t, 0, false, 'H3', 'H4');
        return { t, user };
      }

      it('pages back above what is shown, keeps one divider, then withdraws the button', async () => {
        const { t, user } = await reachIncompleteHistory();
        const button = screen.getByRole('button', BUTTON);
        expect(within(screen.getByRole('log')).queryByRole('button')).toBeNull();
        await user.click(button);
        // The shared throttle may hold the query back for up to 1.1 s.
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        const iq = t.iqs[1];
        expect(iq?.querySelector('before')?.textContent).toBe('H3');
        expect(iq?.querySelector('after')).toBeNull();
        expect(screen.getByRole('button', { name: 'Loading earlier messages…' })).toHaveAttribute(
          'aria-disabled',
          'true',
        );

        pushResult(t, 1, 'H1', 'carol', 'body H1');
        pushResult(t, 1, 'H2', 'carol', 'body H2');
        await answerRsm(t, 1, true, 'H1', 'H2');

        const log = screen.getByRole('log');
        const bubbles = within(log)
          .getAllByText(/^body H\d$/)
          .map((el) => el.textContent);
        expect(bubbles).toEqual(['body H1', 'body H2', 'body H3', 'body H4']);
        expect(screen.queryByRole('button', BUTTON)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Loading earlier messages…' })).toBeNull();
        const separators = within(log).getAllByRole('separator');
        expect(separators).toHaveLength(1);
        expect(separators[0]?.previousElementSibling).toHaveTextContent('body H4');
        expect(log).toHaveFocus();

        act(() => {
          t.pushStanza(
            groupchat(
              'carol',
              'body H2',
              `<stanza-id xmlns="urn:xmpp:sid:0" id="H2" by="${ROOM}"/>`,
              'live-copy',
            ),
          );
        });
        expect(within(log).getAllByText('body H2')).toHaveLength(1);
      }, 20_000);

      it('shows its own error and "Try again", never the recent-messages banner, and retries the same page', async () => {
        const { t, user } = await reachIncompleteHistory();
        await user.click(screen.getByRole('button', BUTTON));
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(2);
          },
          { timeout: 3_000 },
        );
        await act(async () => {
          t.resolveIq(1, { ok: false, condition: 'resource-constraint' });
          await Promise.resolve();
        });
        expect(screen.getByText("Couldn't load earlier messages.")).toBeInTheDocument();
        expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
        const retry = screen.getByRole('button', { name: 'Try again' });
        expect(retry).toHaveAccessibleDescription("Couldn't load earlier messages.");
        await user.click(retry);
        await vi.waitFor(
          () => {
            expect(t.iqs).toHaveLength(3);
          },
          { timeout: 3_000 },
        );
        expect(t.iqs[2]?.querySelector('before')?.textContent).toBe('H3');
        expect(screen.queryByText("Couldn't load recent messages.")).toBeNull();
      }, 20_000);
    });
  });
});
