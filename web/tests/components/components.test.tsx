import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/Composer';
import { LoginForm } from '../../src/components/LoginForm';
import { MessageList } from '../../src/components/MessageList';
import { OccupantList } from '../../src/components/OccupantList';
import type { TimelineItem } from '../../src/state/room';
import type { SendResult } from '../../src/xmpp';

const DOMAIN = 'chaterl.localhost';

function renderLogin(props: Partial<React.ComponentProps<typeof LoginForm>> = {}) {
  const onSubmit = vi.fn();
  render(
    <LoginForm
      domain={DOMAIN}
      defaultUsername="alice"
      busy={false}
      error={null}
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return onSubmit;
}

describe('LoginForm', () => {
  it('has labelled inputs and a page heading', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nearby');
    expect(screen.getByLabelText('Username')).toHaveValue('alice');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveAccessibleDescription(`on ${DOMAIN}`);
  });

  it('disables submit while busy', () => {
    renderLogin({ busy: true });
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });

  it('submits the expanded account address and password, then clears the password', async () => {
    const user = userEvent.setup();
    const onSubmit = renderLogin({ defaultUsername: '' });
    await user.type(screen.getByLabelText('Username'), '  alice  ');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).toHaveBeenCalledWith('alice@chaterl.localhost', 'secret');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('submits a full address on the domain unchanged', async () => {
    const user = userEvent.setup();
    const onSubmit = renderLogin({ defaultUsername: '' });
    await user.type(screen.getByLabelText('Username'), 'bob@chaterl.localhost');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).toHaveBeenCalledWith('bob@chaterl.localhost', 'pw');
  });

  it('shows an alert and does not submit for a wrong domain', async () => {
    const user = userEvent.setup();
    const onSubmit = renderLogin({ defaultUsername: '' });
    await user.type(screen.getByLabelText('Username'), 'alice@evil.example');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(`Use an account on ${DOMAIN}.`);
  });

  it('shows the error prop in an alert', () => {
    renderLogin({ error: 'Wrong username or password.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong username or password.');
  });
});

describe('Composer', () => {
  it('is disabled when told to be', () => {
    render(<Composer disabled onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('has an accessible name and a visible placeholder', () => {
    render(<Composer disabled={false} onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Message the room…',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
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
    expect(screen.getByRole('alert')).toHaveTextContent('Join a room first.');
  });
});

interface MsgOpts {
  isHistory?: boolean;
  isOwn?: boolean;
  sentAt?: number;
}
const msgItem = (id: string, nick: string | null, body: string, o: MsgOpts = {}): TimelineItem => ({
  kind: 'message',
  message: {
    id,
    roomJid: 'r@m',
    nick,
    body,
    sentAt: o.sentAt ?? 0,
    isHistory: o.isHistory ?? false,
    isOwn: o.isOwn ?? false,
  },
});

describe('MessageList', () => {
  it('shows the empty text it is given', () => {
    render(<MessageList items={[]} emptyText="Join a room to start chatting." />);
    expect(screen.getByText('Join a room to start chatting.')).toBeInTheDocument();
  });

  it('renders no empty list item for an empty emptyText', () => {
    render(<MessageList items={[]} emptyText="" />);
    expect(within(screen.getByRole('log')).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('sets aria-busy on the log only while busy', () => {
    const { rerender } = render(<MessageList items={[]} emptyText="" busy />);
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    rerender(<MessageList items={[]} emptyText="" busy={false} />);
    expect(screen.getByRole('log')).not.toHaveAttribute('aria-busy');
    rerender(<MessageList items={[]} emptyText="" />);
    expect(screen.getByRole('log')).not.toHaveAttribute('aria-busy');
  });

  it('distinguishes own from other messages', () => {
    render(
      <MessageList
        items={[msgItem('1', 'alice', 'mine', { isOwn: true }), msgItem('2', 'bob', 'theirs')]}
        emptyText=""
      />,
    );
    expect(screen.getByText('mine').closest('li')).toHaveAttribute('data-own', 'true');
    expect(screen.getByText('theirs').closest('li')).toHaveAttribute('data-own', 'false');
  });

  it('shows "You" in the meta line of own messages', () => {
    render(<MessageList items={[msgItem('1', 'alice', 'mine', { isOwn: true })]} emptyText="" />);
    const li = screen.getByText('mine').closest('li');
    expect(li).not.toBeNull();
    if (li) expect(within(li).getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('alice')).toBeNull();
  });

  it('renders nick-null messages and notices as system rows', () => {
    render(
      <MessageList
        items={[
          msgItem('1', null, 'room says hi'),
          { kind: 'notice', id: 'n1', text: 'bob joined', at: 0 },
        ]}
        emptyText=""
      />,
    );
    expect(screen.getByText('room says hi').closest('li')).toHaveAttribute('data-kind', 'system');
    expect(screen.getByText('bob joined').closest('li')).toHaveAttribute('data-kind', 'system');
  });

  it('shows a separator after history, with no "(earlier)" text', () => {
    render(
      <MessageList
        items={[msgItem('1', 'bob', 'old', { isHistory: true }), msgItem('2', 'bob', 'new')]}
        emptyText=""
      />,
    );
    expect(screen.getByRole('separator', { name: 'Earlier messages above' })).toBeInTheDocument();
    expect(screen.queryByText('(earlier)', { exact: false })).toBeNull();
  });

  it('shows no separator without history', () => {
    render(<MessageList items={[msgItem('1', 'bob', 'live')]} emptyText="" />);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('shows the nick once for a group but keeps the screen-reader attribution', () => {
    render(
      <MessageList
        items={[msgItem('1', 'bob', 'first'), msgItem('2', 'bob', 'second', { sentAt: 1000 })]}
        emptyText=""
      />,
    );
    expect(screen.getAllByText('bob')).toHaveLength(1);
    const second = screen.getByText('second').closest('li');
    expect(second).toHaveAttribute('data-continuation', 'true');
    expect(second?.querySelector('.sr-only')?.textContent).toMatch(/^bob, .+: $/);
  });

  it('renders markup in a body literally', () => {
    render(
      <MessageList items={[msgItem('1', 'bob', '<script>alert(1)</script>')]} emptyText="" />,
    );
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('OccupantList', () => {
  it('shows the count in a sentence-case heading and marks self', () => {
    render(<OccupantList occupants={['alice', 'bob']} selfNick="alice" />);
    const heading = screen.getByRole('heading');
    expect(heading).toHaveTextContent(/People here.*2/);
    expect(heading.textContent).not.toBe(heading.textContent?.toUpperCase());
    expect(screen.getByText('(you)', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows an empty state', () => {
    render(<OccupantList occupants={[]} selfNick={null} />);
    expect(screen.getByText('No one here yet')).toBeInTheDocument();
  });
});
