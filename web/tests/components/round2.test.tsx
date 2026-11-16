import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus } from '../../src/components/ConnectionStatus';
import { RoomForm } from '../../src/components/RoomForm';
import { describeConnectionError, describeMessageError } from '../../src/components/describe';
import type { RoomState } from '../../src/state/room';

describe('describeMessageError', () => {
  it.each([
    ['item-not-found', 'the room is unavailable or locked'],
    ['forbidden', 'you are not allowed to post here'],
    ['not-acceptable', 'you are not in this room'],
    ['resource-constraint', "you're sending too fast"],
    ['policy-violation', "you're sending too fast"],
    ['something-else', 'the server rejected it'],
  ])('%s', (condition, text) => {
    expect(describeMessageError(condition)).toBe(text);
  });
});

describe('describeConnectionError', () => {
  it('describes connection-lost', () => {
    expect(describeConnectionError({ reason: 'connection-lost' })).toBe(
      'Connection lost. Please log in again.',
    );
  });
});

describe('ConnectionStatus', () => {
  it('shows the bare JID, not the resource', () => {
    render(
      <ConnectionStatus state={{ status: 'connected', jid: 'alice@chaterl.localhost/1794-abc' }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('alice@chaterl.localhost');
    expect(screen.getByRole('status')).not.toHaveTextContent('1794-abc');
  });
});

describe('RoomForm leave', () => {
  function Wrapper({ onJoin, onLeave }: { onJoin: () => void; onLeave: () => void }) {
    const [status, setStatus] = useState<RoomState['status']>('joined');
    return (
      <RoomForm
        defaultRoomJid="lobby@muc.chaterl.localhost"
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
          defaultRoomJid="lobby@muc.chaterl.localhost"
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
    const field = screen.getByLabelText('Room JID');
    await user.clear(field);
    await user.type(field, 'other@muc.chaterl.localhost');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
});
