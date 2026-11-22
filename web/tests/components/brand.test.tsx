import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/components/ConfigError';
import { LogoMark } from '../../src/components/Logo';
import { RoomAssignerProvider, type RoomAssigner, type RoomAssignment } from '../../src/geo';
import { Chat } from '../../src/pages/Chat';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { useSessionStore } from '../../src/state/session';
import { XmppProvider, createXmppClient } from '../../src/xmpp';
import { CELL_ROOM } from '../fixtures/stanzas';
import {
  createFakeGeolocation,
  createFakePermissions,
  installGeo,
  uninstallGeo,
} from '../helpers/fakeGeolocation';
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

  afterEach(() => {
    uninstallGeo();
  });

  it('reads "You\'re in Area u4pruyd as alice" and never shows the room address', async () => {
    const geo = createFakeGeolocation();
    installGeo({ geolocation: geo, permissions: createFakePermissions('granted'), secure: true });
    const client = createXmppClient(createFakeTransport(), { mucDomain: 'muc.chaterl.localhost' });
    // The assigner is faked: the page only reads the assignment it is given.
    const assigned: RoomAssignment = {
      status: 'assigned',
      cell: { precision: 7, geohash: 'u4pruyd' },
      room: { jid: CELL_ROOM, cell: 'u4pruyd' },
    };
    const assigner: RoomAssigner = {
      assign: () => undefined,
      retry: () => undefined,
      getState: () => assigned,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    };
    render(
      <XmppProvider client={client}>
        <RoomAssignerProvider assigner={assigner}>
          <Chat mapTileUrl={null} nickname="alice" onSignOut={() => undefined} />
        </RoomAssignerProvider>
      </XmppProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    act(() => {
      useRoomStore.setState({
        roomJid: CELL_ROOM,
        nick: 'alice',
        status: 'joined',
      });
    });
    expect(screen.getByText(/You're in/)).toHaveTextContent("You're in Area u4pruyd as alice");
    expect(document.body.textContent).not.toContain('@muc');
  });
});
