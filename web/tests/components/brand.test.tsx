import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/components/ConfigError';
import { LogoMark } from '../../src/components/Logo';
import { Chat } from '../../src/pages/Chat';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { XmppProvider, createXmppClient } from '../../src/xmpp';
import { createFakeTransport } from '../helpers/fakeTransport';

describe('LogoMark', () => {
  it('is aria-hidden without a title', () => {
    const { container } = render(<LogoMark />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
  });

  it('is an image with a name when it has a title', () => {
    render(<LogoMark title="Nearby logo" />);
    expect(screen.getByRole('img', { name: 'Nearby logo' })).toBeInTheDocument();
  });
});

describe('ConfigError', () => {
  it('shows the heading and every error', () => {
    render(<ConfigError errors={['VITE_XMPP_WS_URL is missing', 'VITE_XMPP_DOMAIN is invalid']} />);
    expect(
      screen.getByRole('heading', { level: 1, name: "Nearby can't start" }),
    ).toBeInTheDocument();
    expect(screen.getByText('VITE_XMPP_WS_URL is missing')).toBeInTheDocument();
    expect(screen.getByText('VITE_XMPP_DOMAIN is invalid')).toBeInTheDocument();
  });
});

describe('Chat page room status', () => {
  beforeEach(() => {
    useSessionStore.setState({
      connection: { status: 'connected', jid: 'alice@chaterl.localhost/r1' },
    });
    useRoomStore.setState({ ...initialRoomState });
  });

  it("reads \"You're in lobby as alice\" and never shows the room address", () => {
    const client = createXmppClient(createFakeTransport(), { mucDomain: 'muc.chaterl.localhost' });
    render(
      <XmppProvider client={client}>
        <Chat mucDomain="muc.chaterl.localhost" />
      </XmppProvider>,
    );
    act(() => {
      useRoomStore.setState({
        roomJid: 'lobby@muc.chaterl.localhost',
        nick: 'alice',
        status: 'joined',
      });
    });
    expect(screen.getByText(/You're in/)).toHaveTextContent("You're in lobby as alice");
    expect(document.body.textContent).not.toContain('@muc');
  });
});
