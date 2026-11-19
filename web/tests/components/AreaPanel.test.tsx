import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AreaPanel } from '../../src/components/AreaPanel';
import type { AreaState } from '../../src/geo';
import { AREA_TEXT } from '../../src/ui/text';

const CELL = { precision: 7, geohash: 'u4pruyd' } as const;

function panel(area: AreaState, extra: { devHint?: boolean } = {}) {
  const onShare = vi.fn();
  const onSwitchArea = vi.fn();
  render(<AreaPanel area={area} onShare={onShare} onSwitchArea={onSwitchArea} {...extra} />);
  return { onShare, onSwitchArea };
}

describe('AreaPanel', () => {
  it.each([
    [{ status: 'checking' }, AREA_TEXT.checking, null],
    [{ status: 'idle' }, AREA_TEXT.idle, AREA_TEXT.share],
    [{ status: 'requesting' }, AREA_TEXT.requesting, null],
    [{ status: 'denied' }, AREA_TEXT.denied, AREA_TEXT.tryAgain],
    [{ status: 'unavailable' }, AREA_TEXT.unavailable, AREA_TEXT.tryAgain],
    [{ status: 'timeout' }, AREA_TEXT.timeout, AREA_TEXT.tryAgain],
    [{ status: 'unsupported' }, AREA_TEXT.unsupported, null],
    [{ status: 'insecure-context' }, AREA_TEXT.insecure, null],
    [
      { status: 'located', cell: CELL, source: 'device', moved: true },
      AREA_TEXT.moved,
      AREA_TEXT.switchArea,
    ],
  ] as const)('%j shows its message in a status region with the right action', (area, text, action) => {
    panel(area);
    expect(screen.getByRole('status')).toHaveTextContent(text);
    const buttons = screen.queryAllByRole('button');
    if (action === null) expect(buttons).toHaveLength(0);
    else {
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(action);
    }
  });

  it('gives every state its own message', () => {
    const texts = [
      AREA_TEXT.checking,
      AREA_TEXT.idle,
      AREA_TEXT.requesting,
      AREA_TEXT.denied,
      AREA_TEXT.unavailable,
      AREA_TEXT.timeout,
      AREA_TEXT.unsupported,
      AREA_TEXT.insecure,
      AREA_TEXT.moved,
    ];
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('adds the test-location hint to the denied message only with devHint', () => {
    panel({ status: 'denied' });
    expect(screen.getByRole('status')).not.toHaveTextContent(AREA_TEXT.deniedDevHint);
  });

  it('shows the hint when devHint is set', () => {
    panel({ status: 'denied' }, { devHint: true });
    expect(screen.getByRole('status')).toHaveTextContent(AREA_TEXT.deniedDevHint);
  });

  it('shows the area code for a located device area, without a test badge', () => {
    panel({ status: 'located', cell: CELL, source: 'device', moved: false });
    expect(screen.getByText('Area u4pruyd')).toBeInTheDocument();
    expect(screen.queryByText(AREA_TEXT.testSpotBadge)).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('badges a test spot', () => {
    panel({ status: 'located', cell: CELL, source: 'dev-pin', moved: false });
    expect(screen.getByText('Area u4pruyd')).toBeInTheDocument();
    expect(screen.getByText(AREA_TEXT.testSpotBadge)).toBeInTheDocument();
  });

  it('calls the right callback', async () => {
    const user = userEvent.setup({ delay: null });
    const { onShare } = panel({ status: 'idle' });
    await user.click(screen.getByRole('button', { name: AREA_TEXT.share }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('"Switch to my new area" calls onSwitchArea', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSwitchArea, onShare } = panel({
      status: 'located',
      cell: CELL,
      source: 'device',
      moved: true,
    });
    await user.click(screen.getByRole('button', { name: AREA_TEXT.switchArea }));
    expect(onSwitchArea).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();
  });

  it('moves focus to the panel when the focused action unmounts', async () => {
    const user = userEvent.setup({ delay: null });
    function Flow(): React.JSX.Element {
      const [area, setArea] = useState<AreaState>({ status: 'idle' });
      return (
        <AreaPanel
          area={area}
          onShare={() => {
            setArea({ status: 'requesting' });
          }}
          onSwitchArea={() => undefined}
        />
      );
    }
    render(<Flow />);
    await user.tab();
    expect(screen.getByRole('button', { name: AREA_TEXT.share })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('region', { name: AREA_TEXT.heading })).toHaveFocus();
  });

  it('keeps focus on the button when "Share" turns into "Try again"', async () => {
    const user = userEvent.setup({ delay: null });
    function Flow(): React.JSX.Element {
      const [area, setArea] = useState<AreaState>({ status: 'idle' });
      return (
        <AreaPanel
          area={area}
          onShare={() => {
            setArea({ status: 'denied' });
          }}
          onSwitchArea={() => undefined}
        />
      );
    }
    render(<Flow />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: AREA_TEXT.tryAgain })).toHaveFocus();
  });

  it('never renders an address or room name', () => {
    panel({ status: 'located', cell: CELL, source: 'dev-pin', moved: true });
    expect(document.body.textContent).not.toContain('@muc');
    expect(document.body.textContent).not.toContain('g7_');
  });
});
