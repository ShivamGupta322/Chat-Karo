import { render, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  RoomAssignerProvider,
  createRoomAssigner,
  useRoomAssignment,
  type Cell,
  type RoomAssigner,
  type RoomAssignment,
} from '../../src/geo';

const start = (): Cell | null => ({ precision: 7, geohash: 'u4pruyd' });
const NONE: RoomAssignment = { status: 'none', room: null };

function fakeAssigner(): RoomAssigner & { assign: ReturnType<typeof vi.fn> } {
  return {
    assign: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(() => Promise.resolve('superseded' as const)),
    getState: () => NONE,
    subscribe: () => () => undefined,
    dispose: vi.fn(),
  };
}

const wrap =
  (assigner: RoomAssigner) =>
  ({ children }: { children: ReactNode }): React.JSX.Element => (
    <RoomAssignerProvider assigner={assigner}>{children}</RoomAssignerProvider>
  );

describe('useRoomAssignment', () => {
  it('throws outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useRoomAssignment(null))).toThrow(/RoomAssignerProvider/);
    spy.mockRestore();
  });

  it('assigns the cell by geohash and exposes the state and retry', () => {
    const assigner = fakeAssigner();
    const { result } = renderHook(() => useRoomAssignment({ precision: 7, geohash: 'u4pruyd' }), {
      wrapper: wrap(assigner),
    });
    expect(assigner.assign).toHaveBeenCalledTimes(1);
    expect(assigner.assign).toHaveBeenCalledWith({ precision: 7, geohash: 'u4pruyd' });
    expect(result.current.assignment).toBe(NONE);
    expect(result.current.retry).toBe(assigner.retry);
  });

  it('a re-render with a new-but-equal Cell makes no new call', () => {
    const assigner = fakeAssigner();
    const { rerender } = renderHook(({ cell }: { cell: Cell | null }) => useRoomAssignment(cell), {
      wrapper: wrap(assigner),
      initialProps: { cell: start() },
    });
    rerender({ cell: { precision: 7, geohash: 'u4pruyd' } });
    expect(assigner.assign).toHaveBeenCalledTimes(1);
    rerender({ cell: { precision: 7, geohash: 'u4pruye' } });
    expect(assigner.assign).toHaveBeenCalledTimes(2);
    rerender({ cell: null });
    expect(assigner.assign).toHaveBeenLastCalledWith(null);
  });

  it('assign(null) on unmount', () => {
    const assigner = fakeAssigner();
    const { unmount } = renderHook(() => useRoomAssignment({ precision: 7, geohash: 'u4pruyd' }), {
      wrapper: wrap(assigner),
    });
    assigner.assign.mockClear();
    unmount();
    expect(assigner.assign).toHaveBeenCalledTimes(1);
    expect(assigner.assign).toHaveBeenCalledWith(null);
  });

  it('a StrictMode mount leaves at most one non-aborted request', () => {
    const signals: AbortSignal[] = [];
    const assigner = createRoomAssigner({
      locate: {
        locate: (_point, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
      },
      online: { isOnline: () => true, subscribe: () => () => undefined },
    });
    function Probe(): null {
      useRoomAssignment({ precision: 7, geohash: 'u4pruyd' });
      return null;
    }
    render(
      <StrictMode>
        <RoomAssignerProvider assigner={assigner}>
          <Probe />
        </RoomAssignerProvider>
      </StrictMode>,
    );
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.filter((sig) => !sig.aborted)).toHaveLength(1);
    assigner.dispose();
  });
});
