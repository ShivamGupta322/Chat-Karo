import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/MessageList';
import type { TimelineItem } from '../../src/state/room';

const msgItem = (id: string, nick = 'bob'): TimelineItem => ({
  kind: 'message',
  message: {
    id,
    roomJid: 'r@m',
    nick,
    body: `body ${id}`,
    sentAt: 0,
    isHistory: true,
    isOwn: false,
  },
});

type Earlier = { status: 'idle' | 'loading' | 'failed'; onLoad: () => void };

describe('MessageList: load earlier', () => {
  afterEach(() => {
    // Only the offsetTop stub below defines an own property on the prototype.
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
  });

  it('shows no button without the prop', () => {
    render(<MessageList items={[msgItem('a')]} emptyText="" />);
    expect(screen.queryByRole('button')).toBeNull();
    render(<MessageList items={[msgItem('b')]} emptyText="" earlier={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('idle: the button sits outside the log and a click calls onLoad once', async () => {
    const onLoad = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(
      <MessageList items={[msgItem('a')]} emptyText="" earlier={{ status: 'idle', onLoad }} />,
    );
    const button = screen.getByRole('button', { name: 'Load earlier messages' });
    expect(within(screen.getByRole('log')).queryByRole('button')).toBeNull();
    expect(screen.getByRole('log')).not.toContainElement(button);
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('idle: Tab then Enter calls onLoad once', async () => {
    const onLoad = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(
      <MessageList items={[msgItem('a')]} emptyText="" earlier={{ status: 'idle', onLoad }} />,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('loading: aria-disabled (not disabled), ignores clicks, keeps focus and marks the log busy', async () => {
    const onLoad = vi.fn();
    const user = userEvent.setup({ delay: null });
    const idle: Earlier = { status: 'idle', onLoad };
    const { rerender } = render(<MessageList items={[msgItem('a')]} emptyText="" earlier={idle} />);
    await user.tab();
    rerender(
      <MessageList
        items={[msgItem('a')]}
        emptyText=""
        earlier={{ status: 'loading', onLoad }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Loading earlier messages…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onLoad).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it('failed: shows the error in a status region, reads "Try again" and retries on click', async () => {
    const onLoad = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(
      <MessageList items={[msgItem('a')]} emptyText="" earlier={{ status: 'failed', onLoad }} />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent("Couldn't load earlier messages.");
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.getAttribute('aria-describedby')).toBe(status.id);
    expect(status.id).not.toBe('');
    await user.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('idle: the status line is present but empty', () => {
    render(
      <MessageList
        items={[msgItem('a')]}
        emptyText=""
        earlier={{ status: 'idle', onLoad: () => undefined }}
      />,
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('moves focus to the log, without scrolling, when the focused button goes away', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(
      <MessageList
        items={[msgItem('a')]}
        emptyText=""
        earlier={{ status: 'idle', onLoad: () => undefined }}
      />,
    );
    await user.tab();
    const log = screen.getByRole('log');
    const focus = vi.spyOn(log, 'focus');
    rerender(<MessageList items={[msgItem('a')]} emptyText="" earlier={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(log).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not steal focus when the button goes away without having focus', () => {
    const { rerender } = render(
      <MessageList
        items={[msgItem('a')]}
        emptyText=""
        earlier={{ status: 'idle', onLoad: () => undefined }}
      />,
    );
    rerender(<MessageList items={[msgItem('a')]} emptyText="" earlier={null} />);
    expect(screen.getByRole('log')).not.toHaveFocus();
  });

  it('gives every row a data-row-key', () => {
    const items: TimelineItem[] = [
      msgItem('a'),
      { kind: 'notice', id: 'notice-1', text: 'bob joined', at: 0 },
    ];
    render(<MessageList items={items} emptyText="" />);
    const rows = within(screen.getByRole('log')).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    for (const li of rows) expect(li).toHaveAttribute('data-row-key');
    expect(document.querySelector('[role="separator"]')).toHaveAttribute(
      'data-row-key',
      'earlier-divider',
    );
  });

  it('keeps the old first row in place when an earlier page lands, even if stuck to the bottom', () => {
    // jsdom has no layout: fake offsetTop from the sibling index (40 px rows, 48 px earlier block).
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement): number {
        const parent = this.parentElement;
        if (!parent || !this.hasAttribute('data-row-key')) return 0;
        const index = Array.from(parent.children).indexOf(this);
        const hasBlock = parent.previousElementSibling !== null;
        return index * 40 + (hasBlock ? 48 : 0);
      },
    });
    const onLoad = vi.fn();
    const first = [msgItem('a', 'bob')];
    const { rerender } = render(
      <MessageList items={first} emptyText="" earlier={{ status: 'idle', onLoad }} />,
    );
    const scroller = screen.getByRole('log').parentElement as HTMLElement;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
    // The user scrolled to the top to find the button.
    top = 0;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(onLoad).toHaveBeenCalledTimes(1);
    act(() => {
      rerender(
        <MessageList items={first} emptyText="" earlier={{ status: 'loading', onLoad }} />,
      );
    });
    expect(top).toBe(0);

    const prepended = [msgItem('x1', 'carol'), msgItem('x2', 'dave'), msgItem('x3', 'erin'), ...first];
    act(() => {
      rerender(
        <MessageList items={prepended} emptyText="" earlier={{ status: 'idle', onLoad }} />,
      );
    });
    expect(top).toBe(120);
  });

  it('still follows the bottom for live messages when no earlier page landed', () => {
    const items = [msgItem('a')];
    const { rerender } = render(<MessageList items={items} emptyText="" />);
    const scroller = screen.getByRole('log').parentElement as HTMLElement;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 700 });
    rerender(<MessageList items={[...items, msgItem('b', 'carol')]} emptyText="" />);
    expect(top).toBe(700);
  });

  it('uses no raw palette classes and no jargon in the new strings', () => {
    const source = readFileSync('src/components/MessageList.tsx', 'utf8');
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/,
    );
    const text = readFileSync('src/ui/text.ts', 'utf8');
    const block = /export const HISTORY_TEXT = \{[\s\S]*?\} as const;/.exec(text)?.[0] ?? '';
    expect(block).toContain('Load earlier messages');
    expect(block).not.toMatch(/MAM|archive|stanza|page/i);
  });
});
