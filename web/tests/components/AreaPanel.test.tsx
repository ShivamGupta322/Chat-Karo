import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AreaPanel } from '../../src/components/AreaPanel';
import type { AreaState, RoomAssignment } from '../../src/geo';
import { AREA_TEXT } from '../../src/ui/text';

const CELL = { precision: 7, geohash: 'u4pruyd' } as const;
const ASSIGNED: RoomAssignment = {
  status: 'assigned',
  cell: CELL,
  room: { jid: 'g7_u4pruyd@muc.chaterl.localhost', cell: 'u4pruyd' },
};
const LOCATED: AreaState = { status: 'located', cell: CELL, source: 'device', moved: false };

function panel(
  area: AreaState,
  extra: { devHint?: boolean; assignment?: RoomAssignment } = {},
) {
  const onShare = vi.fn();
  const onSwitchArea = vi.fn();
  const onRetryAssign = vi.fn();
  const { assignment = area.status === 'located' ? ASSIGNED : { status: 'none', room: null }, ...rest } = extra;
  render(
    <AreaPanel
      area={area}
      assignment={assignment}
      onShare={onShare}
      onSwitchArea={onSwitchArea}
      onRetryAssign={onRetryAssign}
      {...rest}
    />,
  );
  return { onShare, onSwitchArea, onRetryAssign };
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
          assignment={{ status: 'none', room: null }}
          onSwitchArea={() => undefined}
          onRetryAssign={() => undefined}
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
          assignment={{ status: 'none', room: null }}
          onSwitchArea={() => undefined}
          onRetryAssign={() => undefined}
        />
      );
    }
    render(<Flow />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: AREA_TEXT.tryAgain })).toHaveFocus();
  });

  describe('room assignment', () => {
    const failed = (reason: 'unavailable' | 'offline' | 'identity-invalid' | 'bad-response'): RoomAssignment => ({
      status: 'failed',
      cell: CELL,
      reason,
      room: null,
    });

    it.each([
      ['unavailable', AREA_TEXT.locateUnavailable],
      ['offline', AREA_TEXT.locateOffline],
      ['bad-response', AREA_TEXT.locateBadResponse],
    ] as const)('%s shows its text and the retry button', async (reason, text) => {
      const user = userEvent.setup({ delay: null });
      const { onRetryAssign, onShare, onSwitchArea } = panel(LOCATED, { assignment: failed(reason) });
      expect(screen.getByRole('status')).toHaveTextContent(text);
      await user.click(screen.getByRole('button', { name: 'Find my area chat' }));
      expect(onRetryAssign).toHaveBeenCalledTimes(1);
      expect(onShare).not.toHaveBeenCalled();
      expect(onSwitchArea).not.toHaveBeenCalled();
    });

    it('identity-invalid shows its text and no button', () => {
      panel(LOCATED, { assignment: failed('identity-invalid') });
      expect(screen.getByRole('status')).toHaveTextContent(AREA_TEXT.locateIdentityInvalid);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('shows the assigning text for the area, with no button', () => {
      panel(LOCATED, { assignment: { status: 'assigning', cell: CELL, room: null } });
      expect(screen.getByRole('status')).toHaveTextContent('Finding the chat for Area u4pruyd…');
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('a failure takes precedence over "moved"', () => {
      panel({ ...LOCATED, moved: true }, { assignment: failed('unavailable') });
      expect(screen.getByRole('status')).toHaveTextContent(AREA_TEXT.locateUnavailable);
      expect(screen.queryByRole('button', { name: AREA_TEXT.switchArea })).toBeNull();
    });

    it('moved still shows when the room is assigned', () => {
      panel({ ...LOCATED, moved: true });
      expect(screen.getByRole('status')).toHaveTextContent(AREA_TEXT.moved);
    });

    it('moves focus to the panel when the focused retry button disappears', async () => {
      const user = userEvent.setup({ delay: null });
      function Flow(): React.JSX.Element {
        const [assignment, setAssignment] = useState<RoomAssignment>(failed('unavailable'));
        return (
          <AreaPanel
            area={LOCATED}
            assignment={assignment}
            onShare={() => undefined}
            onSwitchArea={() => undefined}
            onRetryAssign={() => {
              setAssignment({ status: 'assigning', cell: CELL, room: null });
            }}
          />
        );
      }
      render(<Flow />);
      await user.tab();
      expect(screen.getByRole('button', { name: AREA_TEXT.retryAssign })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByRole('region', { name: AREA_TEXT.heading })).toHaveFocus();
    });

    it('never renders a room address while assigned or failed', () => {
      panel(LOCATED);
      expect(document.body.textContent).not.toContain('@muc');
      expect(document.body.textContent).not.toContain('g7_');
    });
  });

  it('never renders an address or room name', () => {
    panel({ status: 'located', cell: CELL, source: 'dev-pin', moved: true });
    expect(document.body.textContent).not.toContain('@muc');
    expect(document.body.textContent).not.toContain('g7_');
  });
});
