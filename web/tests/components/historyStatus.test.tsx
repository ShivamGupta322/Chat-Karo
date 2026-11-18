import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HistoryStatus } from '../../src/components/HistoryStatus';
import type { RoomHistory } from '../../src/state/room';

const idle: RoomHistory = { loading: false, failed: false, canLoadEarlier: false, insertAt: 0 };

describe('HistoryStatus', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<HistoryStatus history={idle} onRetry={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces loading in a status region', () => {
    render(<HistoryStatus history={{ ...idle, loading: true }} onRetry={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading recent messages…');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the failure with a Try again button that works from the keyboard', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(<HistoryStatus history={{ ...idle, failed: true }} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load recent messages.");
    await user.tab();
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses no raw palette classes', () => {
    const source = readFileSync('src/components/HistoryStatus.tsx', 'utf8');
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/,
    );
  });

  it('keeps jargon out of the strings', () => {
    const source = readFileSync('src/ui/text.ts', 'utf8');
    const block = /export const HISTORY_TEXT = \{[\s\S]*?\} as const;/.exec(source)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).not.toMatch(/MAM|archive|stanza/i);
  });
});
