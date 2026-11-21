import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../../src/components/AppHeader';
import { ConnectionStatus } from '../../src/components/ConnectionStatus';
import { describeConnectionError } from '../../src/ui/text';

describe('describeConnectionError', () => {
  it('describes connection-lost', () => {
    expect(describeConnectionError({ reason: 'connection-lost' })).toBe(
      'Connection lost. Try again.',
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
    [{ status: 'reconnecting', jid: 'a@b/c', attempt: 1, nextAttemptAt: null }, 'Reconnecting…'],
    [{ status: 'disconnected' }, 'Offline'],
  ] as const)('%j reads %s', (state, text) => {
    render(<ConnectionStatus state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });
});

describe('AppHeader', () => {
  it('shows the nickname, not an address, and signs out', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(
      <AppHeader
        connection={{ status: 'connected', jid: 'u0123456789abcdef0123456789abcdef@chaterl.localhost/1794-abc' }}
        name="Alice_1"
        onSignOut={onSignOut}
      />,
    );
    expect(screen.getByText('Alice_1')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('chaterl.localhost');
    expect(document.body.textContent).not.toContain('u0123456789abcdef');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nearby');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
