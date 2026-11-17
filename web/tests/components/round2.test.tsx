import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../../src/components/AppHeader';
import { ConnectionStatus } from '../../src/components/ConnectionStatus';
import { RoomForm } from '../../src/components/RoomForm';
import { describeConnectionError } from '../../src/ui/text';
import type { RoomState } from '../../src/state/room';

describe('describeConnectionError', () => {
  it('describes connection-lost', () => {
    expect(describeConnectionError({ reason: 'connection-lost' })).toBe(
      'Connection lost. Please sign in again.',
    );
  });
});

describe('ConnectionStatus', () => {
  it('shows Online, without the domain or resource', () => {
    render(
      <ConnectionStatus state={{ status: 'connected', jid: 'alice@chaterl.localhost/1794-abc' }} />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Online');
    expect(status).not.toHaveTextContent('chaterl.localhost');
    expect(status).not.toHaveTextContent('1794-abc');
  });

  it.each([
    [{ status: 'idle' }, 'Offline'],
    [{ status: 'connecting' }, 'Connecting…'],
    [{ status: 'disconnecting' }, 'Signing out…'],
    [{ status: 'disconnected' }, 'Offline'],
  ] as const)('%j reads %s', (state, text) => {
    render(<ConnectionStatus state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });
});

describe('AppHeader', () => {
  it('shows the account name, not the full address, and signs out', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(
      <AppHeader
        connection={{ status: 'connected', jid: 'alice@chaterl.localhost/1794-abc' }}
        onSignOut={onSignOut}
      />,
    );
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('chaterl.localhost');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nearby');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('RoomForm leave', () => {
  function Wrapper({ onJoin, onLeave }: { onJoin: () => void; onLeave: () => void }) {
    const [status, setStatus] = useState<RoomState['status']>('joined');
    return (
      <RoomForm
        defaultRoom="lobby"
        defaultNick="alice"
        mucDomain="muc.chaterl.localhost"
        status={status}
        onJoin={onJoin}
        onLeave={() => {
          onLeave();
          flushSync(() => { setStatus('left'); });
        }}
      />
    );
  }

  it('Leave does not also re-join', async () => {
    const onJoin = vi.fn();
    const onLeave = vi.fn();
    const user = userEvent.setup();
    render(<Wrapper onJoin={onJoin} onLeave={onLeave} />);
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('Leave does not re-join even when the room field was edited', async () => {
    const onJoin = vi.fn();
    const onLeave = vi.fn();
    const user = userEvent.setup();
    function Flow() {
      const [status, setStatus] = useState<RoomState['status']>('left');
      return (
        <RoomForm
          defaultRoom="lobby"
          defaultNick="alice"
          mucDomain="muc.chaterl.localhost"
          status={status}
          onJoin={() => {
            onJoin();
            setStatus('joined');
          }}
          onLeave={() => {
            onLeave();
            flushSync(() => { setStatus('left'); });
          }}
        />
      );
    }
    render(<Flow />);
    const field = screen.getByLabelText('Room');
    await user.clear(field);
    await user.type(field, 'other');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
});

describe('RoomForm join', () => {
  const props = {
    defaultRoom: 'lobby',
    defaultNick: 'alice',
    mucDomain: 'muc.chaterl.localhost',
    status: 'none' as const,
    onLeave: vi.fn(),
  };

  it('expands a room name to a full address on join', async () => {
    const onJoin = vi.fn();
    const user = userEvent.setup();
    render(<RoomForm {...props} onJoin={onJoin} />);
    const field = screen.getByLabelText('Room');
    await user.clear(field);
    await user.type(field, 'test2');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith('test2@muc.chaterl.localhost', 'alice');
  });

  it('shows an alert and does not join for an invalid room', async () => {
    const onJoin = vi.fn();
    const user = userEvent.setup();
    render(<RoomForm {...props} onJoin={onJoin} />);
    const field = screen.getByLabelText('Room');
    await user.clear(field);
    await user.type(field, 'Lobby');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Room names use lowercase/);
  });
});
