import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/Composer';
import { LoginForm } from '../../src/components/LoginForm';
import { MessageList } from '../../src/components/MessageList';
import { OccupantList } from '../../src/components/OccupantList';
import { describeConnectionError, describeJoinFailure } from '../../src/components/describe';
import type { TimelineItem } from '../../src/state/room';
import type { JoinFailure, SendResult } from '../../src/xmpp';

describe('LoginForm', () => {
  it('has labelled inputs', () => {
    render(<LoginForm defaultJid="a@b" busy={false} error={null} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('JID')).toHaveValue('a@b');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('disables submit while busy', () => {
    render(<LoginForm defaultJid="a@b" busy error={null} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('submits the trimmed JID and password, then clears the password', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<LoginForm defaultJid="" busy={false} error={null} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('JID'), '  alice@chaterl.localhost  ');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(onSubmit).toHaveBeenCalledWith('alice@chaterl.localhost', 'secret');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('shows the error in an alert', () => {
    render(<LoginForm defaultJid="a@b" busy={false} error="Wrong JID or password" onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong JID or password');
  });
});

describe('Composer', () => {
  it('is disabled when told to be', () => {
    render(<Composer disabled onSend={vi.fn()} />);
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('submits on Enter and clears on ok', async () => {
    const onSend = vi.fn((): SendResult => ({ ok: true, id: '1' }));
    const user = userEvent.setup();
    render(<Composer disabled={false} onSend={onSend} />);
    await user.type(screen.getByLabelText('Message'), 'hello{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('keeps the text and shows an error when not ok', async () => {
    const onSend = vi.fn((): SendResult => ({ ok: false, error: 'not-joined' }));
    const user = userEvent.setup();
    render(<Composer disabled={false} onSend={onSend} />);
    await user.type(screen.getByLabelText('Message'), 'hello{Enter}');
    expect(screen.getByLabelText('Message')).toHaveValue('hello');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

const msgItem = (id: string, nick: string | null, body: string, isHistory = false): TimelineItem => ({
  kind: 'message',
  message: { id, roomJid: 'r@m', nick, body, sentAt: 0, isHistory, isOwn: false },
});

describe('MessageList', () => {
  it('shows an empty state', () => {
    render(<MessageList items={[]} selfNick="alice" />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('distinguishes own from other messages', () => {
    render(
      <MessageList items={[msgItem('1', 'alice', 'mine'), msgItem('2', 'bob', 'theirs')]} selfNick="alice" />,
    );
    expect(screen.getByText('mine').closest('li')).toHaveAttribute('data-own', 'true');
    expect(screen.getByText('theirs').closest('li')).toHaveAttribute('data-own', 'false');
  });

  it('renders nick-null messages and notices as system lines', () => {
    render(
      <MessageList
        items={[msgItem('1', null, 'room says hi'), { kind: 'notice', id: 'n1', text: 'bob joined', at: 0 }]}
        selfNick="alice"
      />,
    );
    expect(screen.getByText('room says hi').closest('li')).toHaveClass('italic');
    expect(screen.getByText('bob joined')).toHaveClass('italic');
  });

  it('marks history for screen readers', () => {
    render(<MessageList items={[msgItem('1', 'bob', 'old', true)]} selfNick="alice" />);
    expect(screen.getByText('(earlier)', { exact: false })).toBeInTheDocument();
  });

  it('renders markup in a body literally', () => {
    render(<MessageList items={[msgItem('1', 'bob', '<script>alert(1)</script>')]} selfNick="alice" />);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('OccupantList', () => {
  it('shows the count and marks self', () => {
    render(<OccupantList occupants={['alice', 'bob']} selfNick="alice" />);
    expect(screen.getByRole('heading')).toHaveTextContent('Occupants (2)');
    expect(screen.getByText('(you)')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('describe', () => {
  const all: JoinFailure[] = [
    'conflict',
    'not-authorized',
    'forbidden',
    'registration-required',
    'service-unavailable',
    'not-acceptable',
    'item-not-found',
    'timeout',
    'room-config-failed',
    'not-connected',
    'invalid-room',
    'invalid-nick',
    'other',
  ];
  it.each(all)('describes join failure %s', (reason) => {
    expect(describeJoinFailure(reason).length).toBeGreaterThan(0);
  });
  it('describes connection errors', () => {
    expect(describeConnectionError({ reason: 'auth-failed' })).toBe('Wrong JID or password');
    expect(describeConnectionError({ reason: 'connection-failed' })).toContain("Can't reach");
    expect(describeJoinFailure('conflict')).toBe('That nickname is taken');
  });
});
