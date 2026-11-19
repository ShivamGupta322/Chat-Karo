import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WATCH_OPTIONS,
  initialLocation,
  reduceLocation,
  useLocation,
  type LocationDeps,
} from '../../src/geo/useLocation';
import {
  createFakeGeolocation,
  createFakePermissions,
  installGeo,
  uninstallGeo,
  type FakeGeolocation,
  type FakePermissions,
} from '../helpers/fakeGeolocation';

afterEach(() => {
  uninstallGeo();
});

function deps(
  geo: FakeGeolocation | null,
  permissions: FakePermissions | null = null,
  isSecureContext: boolean | undefined = true,
): LocationDeps {
  return { geolocation: geo, permissions, isSecureContext };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useLocation', () => {
  it('is unsupported without geolocation', () => {
    const { result } = renderHook(() => useLocation(7, deps(null)));
    expect(result.current.state).toEqual({ status: 'unsupported' });
  });

  it('is insecure-context when isSecureContext is strictly false, and starts no watch', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo, null, false)));
    expect(result.current.state).toEqual({ status: 'insecure-context' });
    expect(geo.watchCalls()).toBe(0);
  });

  it('treats an undefined isSecureContext as secure', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo, null, undefined)));
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('is idle without a Permissions API and waits for start()', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(geo.watchCalls()).toBe(0);
    act(() => {
      result.current.start();
    });
    expect(result.current.state).toEqual({ status: 'requesting' });
    expect(geo.activeWatches()).toBe(1);
  });

  it('reads the real globals when no deps are injected', () => {
    const geo = createFakeGeolocation();
    installGeo({ geolocation: geo, permissions: null, secure: true });
    const { result } = renderHook(() => useLocation(7));
    expect(result.current.state).toEqual({ status: 'idle' });
    act(() => {
      result.current.start();
    });
    expect(geo.activeWatches()).toBe(1);
  });

  it('is unsupported on the real globals when navigator has no geolocation', () => {
    installGeo({ geolocation: null });
    const { result } = renderHook(() => useLocation(7));
    expect(result.current.state).toEqual({ status: 'unsupported' });
  });

  it('checks, then goes idle on a prompt permission', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('prompt');
    const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
    expect(result.current.state).toEqual({ status: 'checking' });
    await flush();
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(geo.watchCalls()).toBe(0);
  });

  it('auto-starts on a granted permission: requesting, then watching with only a cell', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('granted');
    const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
    await flush();
    expect(result.current.state).toEqual({ status: 'requesting' });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    expect(result.current.state).toEqual({
      status: 'watching',
      cell: { precision: 7, geohash: 'u4pruyd' },
    });
  });

  it('asks the browser for low-accuracy, cached, time-limited fixes', () => {
    expect(WATCH_OPTIONS).toEqual({
      enableHighAccuracy: false,
      timeout: 20_000,
      maximumAge: 60_000,
    });
  });

  it('is denied at mount without ever calling watchPosition', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('denied');
    const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
    await flush();
    expect(result.current.state).toEqual({ status: 'denied' });
    expect(geo.watchCalls()).toBe(0);
  });

  it('goes idle when the permission query rejects', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('reject');
    const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
    await flush();
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it.each([
    [1, 'denied'],
    [2, 'unavailable'],
    [3, 'timeout'],
  ] as const)('error code %d before a fix -> %s and clears the watch', (code, status) => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.fail(code);
    });
    expect(result.current.state).toEqual({ status });
    expect(geo.activeWatches()).toBe(0);
    expect(geo.clearCalls()).toBe(1);
  });

  it('after a fix, timeout and unavailable are ignored and the watch continues', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    const before = result.current.state;
    act(() => {
      geo.fail(3);
    });
    act(() => {
      geo.fail(2);
    });
    expect(result.current.state).toBe(before);
    expect(geo.activeWatches()).toBe(1);
  });

  it('after a fix, a denied error clears the watch and shows denied', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    act(() => {
      geo.fail(1);
    });
    expect(result.current.state).toEqual({ status: 'denied' });
    expect(geo.activeWatches()).toBe(0);
  });

  it('treats an out-of-range fix as unavailable', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(123, 10);
    });
    expect(result.current.state).toEqual({ status: 'unavailable' });
    expect(geo.activeWatches()).toBe(0);
  });

  it('start() from timeout leaves exactly one active watch', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.fail(3);
    });
    expect(geo.activeWatches()).toBe(0);
    act(() => {
      result.current.start();
    });
    expect(result.current.state).toEqual({ status: 'requesting' });
    expect(geo.activeWatches()).toBe(1);
    expect(geo.watchCalls()).toBe(2);
  });

  it('start() while watching clears the old watch before creating the new one', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.start();
    });
    expect(geo.activeWatches()).toBe(1);
    expect(geo.clearCalls()).toBe(1);
  });

  describe('permission changes', () => {
    it('granted while idle starts a watch', async () => {
      const geo = createFakeGeolocation();
      const perms = createFakePermissions('prompt');
      const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
      await flush();
      act(() => {
        perms.setState('granted');
      });
      expect(result.current.state).toEqual({ status: 'requesting' });
      expect(geo.activeWatches()).toBe(1);
    });

    it('denied clears the watch and shows denied', async () => {
      const geo = createFakeGeolocation();
      const perms = createFakePermissions('granted');
      const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
      await flush();
      act(() => {
        geo.emit(57.64911, 10.40744);
      });
      act(() => {
        perms.setState('denied');
      });
      expect(result.current.state).toEqual({ status: 'denied' });
      expect(geo.activeWatches()).toBe(0);
    });

    it('prompt while denied returns to idle', async () => {
      const geo = createFakeGeolocation();
      const perms = createFakePermissions('denied');
      const { result } = renderHook(() => useLocation(7, deps(geo, perms)));
      await flush();
      act(() => {
        perms.setState('prompt');
      });
      expect(result.current.state).toEqual({ status: 'idle' });
    });

    it('granted while denied starts again', async () => {
      const geo = createFakeGeolocation();
      const perms = createFakePermissions('denied');
      renderHook(() => useLocation(7, deps(geo, perms)));
      await flush();
      act(() => {
        perms.setState('granted');
      });
      expect(geo.activeWatches()).toBe(1);
    });
  });

  it('ignores a permission query that resolves after unmount', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('granted');
    const { unmount } = renderHook(() => useLocation(7, deps(geo, perms)));
    unmount();
    await flush();
    expect(geo.watchCalls()).toBe(0);
    expect(perms.listenerCount()).toBe(0);
  });

  it('unmount clears the watch and removes the change listener', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('granted');
    const { unmount } = renderHook(() => useLocation(7, deps(geo, perms)));
    await flush();
    expect(geo.activeWatches()).toBe(1);
    expect(perms.listenerCount()).toBe(1);
    unmount();
    expect(geo.activeWatches()).toBe(0);
    expect(perms.listenerCount()).toBe(0);
  });

  it('under StrictMode ends with exactly one active watch and one listener', async () => {
    const geo = createFakeGeolocation();
    const perms = createFakePermissions('granted');
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <StrictMode>{children}</StrictMode>
    );
    renderHook(() => useLocation(7, deps(geo, perms)), { wrapper });
    await flush();
    expect(geo.activeWatches()).toBe(1);
    expect(perms.listenerCount()).toBe(1);
  });

  it('keeps the same state object for a second fix in the same cell', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    const first = result.current.state;
    act(() => {
      geo.emit(57.6492, 10.4075);
    });
    expect(result.current.state).toBe(first);
    act(() => {
      geo.emit(57.64911, 10.4087);
    });
    expect(result.current.state).not.toBe(first);
  });

  it('never holds a coordinate or an error detail in its state', () => {
    const geo = createFakeGeolocation();
    const { result } = renderHook(() => useLocation(7, deps(geo)));
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(57.64911, 10.40744);
    });
    expect(JSON.stringify(result.current.state)).not.toContain('57.6');
    expect(JSON.stringify(result.current.state)).not.toContain('10.4');
    act(() => {
      geo.fail(1);
    });
    expect(JSON.stringify(result.current.state)).not.toContain('secret');
  });
});

describe('reduceLocation / initialLocation', () => {
  it('orders unsupported before insecure before checking/idle', () => {
    const geo = createFakeGeolocation();
    expect(initialLocation(deps(null, null, false))).toEqual({ status: 'unsupported' });
    expect(initialLocation(deps(geo, createFakePermissions('prompt'), false))).toEqual({
      status: 'insecure-context',
    });
    expect(initialLocation(deps(geo, createFakePermissions('prompt')))).toEqual({
      status: 'checking',
    });
  });

  it('start is a no-op while already requesting', () => {
    const s = { status: 'requesting' } as const;
    expect(reduceLocation(s, { type: 'start' })).toBe(s);
  });
});
