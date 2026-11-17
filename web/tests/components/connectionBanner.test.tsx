import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';

type Props = React.ComponentProps<typeof ConnectionBanner>;

function state(nextAttemptAt: number | null): Props['state'] {
  return { status: 'reconnecting', jid: 'alice@chaterl.localhost/r1', attempt: 1, nextAttemptAt };
}

describe('ConnectionBanner', () => {
  let clock = 0;
  const now = (): number => clock;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down every second', () => {
    render(<ConnectionBanner state={state(4_000)} onRetryNow={() => undefined} now={now} />);
    expect(screen.getByText('Reconnecting in 3s…')).toBeInTheDocument();
    act(() => {
      clock += 1_000;
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('Reconnecting in 2s…')).toBeInTheDocument();
  });

  it('never shows a negative countdown', () => {
    render(<ConnectionBanner state={state(500)} onRetryNow={() => undefined} now={now} />);
    expect(screen.getByText('Reconnecting in 0s…')).toBeInTheDocument();
  });

  it('shows plain "Reconnecting…" while an attempt is in flight', () => {
    render(<ConnectionBanner state={state(null)} onRetryNow={() => undefined} now={now} />);
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Try now is a native button reachable by keyboard and calls onRetryNow', () => {
    // userEvent's async polling hangs under fake timers, so focus and click directly.
    const onRetryNow = vi.fn();
    render(<ConnectionBanner state={state(4_000)} onRetryNow={onRetryNow} now={now} />);
    const button = screen.getByRole('button', { name: 'Try now' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('the status region holds the static text but not the countdown', () => {
    render(<ConnectionBanner state={state(4_000)} onRetryNow={() => undefined} now={now} />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Connection lost.');
    expect(region).toHaveTextContent("We'll reconnect automatically.");
    expect(region).not.toHaveTextContent(/\d+s/);
    expect(screen.getByRole('button', { name: 'Try now' }).closest('[role="status"]')).toBeNull();
  });

  it('clears its interval on unmount', () => {
    const { unmount } = render(
      <ConnectionBanner state={state(4_000)} onRetryNow={() => undefined} now={now} />,
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
