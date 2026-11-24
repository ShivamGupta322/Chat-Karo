import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialRoomState, useRoomStore } from '../../src/state/room';
import { ACCESS_FAILURES, useAccessRecovery } from '../../src/state/useAccessRecovery';
import type { JoinFailure, XmppClient } from '../../src/xmpp/types';

const MUC = 'muc.chaterl.localhost';
const R1 = `g7_u4pruyd@${MUC}`;
const R2 = `g7_u4pruye@${MUC}`;

type Outcome = 'assigned' | 'failed' | 'superseded';

function deferred(): { promise: Promise<Outcome>; resolve(o: Outcome): void } {
  let resolve: (o: Outcome) => void = () => undefined;
  const promise = new Promise<Outcome>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useAccessRecovery', () => {
  let joinRoom: ReturnType<typeof vi.fn>;
  let client: XmppClient;
  let pending: ReturnType<typeof deferred>[];
  let refresh: ReturnType<typeof vi.fn<() => Promise<Outcome>>>;

  const fail = (roomJid: string, reason: JoinFailure): void => {
    act(() => {
      useRoomStore.setState({
        roomJid,
        status: 'failed',
        failure: { reason },
        nick: null,
      });
    });
  };
  const setStatus = (roomJid: string, status: 'joining' | 'joined'): void => {
    act(() => {
      useRoomStore.setState({ roomJid, status, failure: null, nick: 'alice' });
    });
  };
  const answer = async (i: number, outcome: Outcome): Promise<void> => {
    await act(async () => {
      pending[i]?.resolve(outcome);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const mount = (desired: string | null, strict = false) =>
    renderHook(
      ({ desired: d }: { desired: string | null }) =>
        useAccessRecovery({ client, desired: d, nick: 'alice', refresh }),
      {
        initialProps: { desired },
        ...(strict
          ? {
              wrapper: ({ children }: { children: ReactNode }): React.JSX.Element => (
                <StrictMode>{children}</StrictMode>
              ),
            }
          : {}),
      },
    );

  beforeEach(() => {
    vi.useFakeTimers();
    useRoomStore.setState({ ...initialRoomState });
    joinRoom = vi.fn();
    client = { joinRoom } as unknown as XmppClient;
    pending = [];
    refresh = vi.fn(() => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('knows exactly the two access failures', () => {
    expect([...ACCESS_FAILURES].sort()).toEqual(['not-allowed', 'registration-required']);
  });

  it.each(['registration-required', 'not-allowed'] as const)(
    '%s: exactly one refresh, then one joinRoom(desired, nick)',
    async (reason) => {
      const { result } = mount(R1);
      setStatus(R1, 'joining');
      fail(R1, reason);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.current.phase).toBe('recovering');
      expect(joinRoom).not.toHaveBeenCalled();
      await answer(0, 'assigned');
      expect(joinRoom).toHaveBeenCalledTimes(1);
      expect(joinRoom).toHaveBeenCalledWith(R1, 'alice');
      expect(result.current.phase).toBe('idle');
    },
  );

  it('a second failure is exhausted: no further request, even a minute later', async () => {
    const { result } = mount(R1);
    fail(R1, 'not-allowed');
    await answer(0, 'assigned');
    setStatus(R1, 'joining');
    fail(R1, 'not-allowed');
    expect(result.current.phase).toBe('exhausted');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it('recover() refreshes and joins regardless of attempts; it is ignored while recovering', async () => {
    const { result } = mount(R1);
    fail(R1, 'not-allowed');
    await answer(0, 'assigned');
    setStatus(R1, 'joining');
    fail(R1, 'not-allowed');
    expect(result.current.phase).toBe('exhausted');
    act(() => {
      result.current.recover();
    });
    expect(result.current.phase).toBe('recovering');
    act(() => {
      result.current.recover();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await answer(1, 'assigned');
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom).toHaveBeenLastCalledWith(R1, 'alice');
    expect(result.current.phase).toBe('idle');
  });

  it('a successful join resets, so a later access failure recovers again', async () => {
    mount(R1);
    fail(R1, 'not-allowed');
    await answer(0, 'assigned');
    setStatus(R1, 'joined');
    fail(R1, 'registration-required');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a different non-null desired room starts afresh', async () => {
    const { result, rerender } = mount(R1);
    fail(R1, 'not-allowed');
    await answer(0, 'assigned');
    setStatus(R1, 'joining');
    fail(R1, 'not-allowed');
    expect(result.current.phase).toBe('exhausted');
    rerender({ desired: R2 });
    expect(result.current.phase).toBe('idle');
    fail(R2, 'not-allowed');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('going to no room and back to the same one does not reset', async () => {
    const { result, rerender } = mount(R1);
    fail(R1, 'not-allowed');
    await answer(0, 'assigned');
    setStatus(R1, 'joining');
    fail(R1, 'not-allowed');
    expect(result.current.phase).toBe('exhausted');
    rerender({ desired: null });
    rerender({ desired: R1 });
    expect(result.current.phase).toBe('exhausted');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh that cleared the desired room still counts as no attempt (regression)', async () => {
    // After a MongooseIM restart: refused rejoin → refresh → 503. The assigner's fail() sets room null, so
    // `desired` is already null when the refresh settles; its own retry later brings back the same room.
    const { result, rerender } = mount(R1);
    fail(R1, 'not-allowed');
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ desired: null });
    await answer(0, 'failed');
    expect(result.current.phase).toBe('idle');
    rerender({ desired: R1 });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('recovering');
    await answer(1, 'assigned');
    expect(joinRoom).toHaveBeenCalledWith(R1, 'alice');
  });

  it.each(['conflict', 'service-unavailable', 'forbidden', 'timeout', 'other'] as const)(
    'ignores %s',
    (reason) => {
      const { result } = mount(R1);
      fail(R1, reason);
      expect(refresh).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('idle');
    },
  );

  it('ignores a failure of a room that is not the desired one', () => {
    mount(R1);
    fail(R2, 'not-allowed');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('unmounting during the refresh joins nothing', async () => {
    const { unmount } = mount(R1);
    fail(R1, 'not-allowed');
    unmount();
    await answer(0, 'assigned');
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('does not join when the desired room changed while refreshing', async () => {
    const { rerender } = mount(R1);
    fail(R1, 'not-allowed');
    rerender({ desired: R2 });
    await answer(0, 'assigned');
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it.each(['failed', 'superseded'] as const)(
    'a %s refresh goes back to idle with the attempt given back',
    async (outcome) => {
      const { result } = mount(R1);
      fail(R1, 'not-allowed');
      await answer(0, outcome);
      expect(joinRoom).not.toHaveBeenCalled();
      expect(result.current.phase).toBe('idle');
      // The next access failure may recover again (attempts are back to 0).
      setStatus(R1, 'joining');
      fail(R1, 'not-allowed');
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it('a StrictMode mount still sends a single refresh', () => {
    mount(R1, true);
    fail(R1, 'not-allowed');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
