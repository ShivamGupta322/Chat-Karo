import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useArea } from '../../src/geo/useArea';
import { createFakeGeolocation, installGeo, uninstallGeo, type FakeGeolocation } from '../helpers/fakeGeolocation';

const A = { lat: 57.64911, lng: 10.40744 }; // u4pruyd
const A_SAME_CELL = { lat: 57.6492, lng: 10.4075 }; // u4pruyd
const B = { lat: 57.64911, lng: 10.4087 }; // u4pruye
const C = { lat: 51.5074, lng: -0.1278 }; // gcpvj0d

let geo: FakeGeolocation;

beforeEach(() => {
  geo = createFakeGeolocation();
  installGeo({ geolocation: geo, permissions: null, secure: true });
});

afterEach(() => {
  uninstallGeo();
});

function mountLocated(): ReturnType<typeof renderHook<ReturnType<typeof useArea>, unknown>> {
  const hook = renderHook(() => useArea());
  act(() => {
    hook.result.current.start();
  });
  act(() => {
    geo.emit(A.lat, A.lng);
  });
  return hook;
}

describe('useArea', () => {
  it('starts idle and commits to the first device fix', () => {
    const { result } = renderHook(() => useArea());
    expect(result.current.state).toEqual({ status: 'idle' });
    act(() => {
      result.current.start();
    });
    expect(result.current.state).toEqual({ status: 'requesting' });
    act(() => {
      geo.emit(A.lat, A.lng);
    });
    expect(result.current.state).toEqual({
      status: 'located',
      cell: { precision: 7, geohash: 'u4pruyd' },
      source: 'device',
      moved: false,
    });
  });

  it('a fix in another cell only flags moved; commitMove then switches', () => {
    const { result } = mountLocated();
    act(() => {
      geo.emit(B.lat, B.lng);
    });
    expect(result.current.state).toEqual({
      status: 'located',
      cell: { precision: 7, geohash: 'u4pruyd' },
      source: 'device',
      moved: true,
    });
    act(() => {
      result.current.commitMove();
    });
    expect(result.current.state).toEqual({
      status: 'located',
      cell: { precision: 7, geohash: 'u4pruye' },
      source: 'device',
      moved: false,
    });
  });

  it('keeps the same state object across a same-cell device fix', () => {
    const { result } = mountLocated();
    const before = result.current.state;
    act(() => {
      geo.emit(A_SAME_CELL.lat, A_SAME_CELL.lng);
    });
    expect(result.current.state).toBe(before);
  });

  it('keeps the same state object when moved stays true across more fixes elsewhere', () => {
    const { result } = mountLocated();
    act(() => {
      geo.emit(B.lat, B.lng);
    });
    const before = result.current.state;
    act(() => {
      geo.emit(C.lat, C.lng);
    });
    expect(result.current.state).toBe(before);
  });

  it('a valid dev spot becomes a dev-pin; an invalid one reports an error and changes nothing', () => {
    const { result } = mountLocated();
    let res: ReturnType<typeof result.current.dev.set> | undefined;
    act(() => {
      res = result.current.dev.set(B);
    });
    expect(res).toEqual({ ok: true });
    expect(result.current.state).toEqual({
      status: 'located',
      cell: { precision: 7, geohash: 'u4pruye' },
      source: 'dev-pin',
      moved: false,
    });
    expect(result.current.dev.active).toBe(true);
    const before = result.current.state;
    act(() => {
      res = result.current.dev.set({ lat: 99, lng: 0 });
    });
    expect(res).toEqual({ ok: false, error: 'lat-out-of-range' });
    expect(result.current.state).toBe(before);
    act(() => {
      res = result.current.dev.set({ lat: 0, lng: 999 });
    });
    expect(res).toEqual({ ok: false, error: 'lng-out-of-range' });
    expect(result.current.state).toBe(before);
  });

  it('setting a dev spot in the same cell keeps the same state reference', () => {
    const { result } = mountLocated();
    act(() => {
      result.current.dev.set(B);
    });
    const before = result.current.state;
    act(() => {
      result.current.dev.set({ lat: 57.6491, lng: 10.4088 });
    });
    expect(result.current.state).toBe(before);
  });

  it('dev.clear returns to the latest device cell', () => {
    const { result } = mountLocated();
    act(() => {
      result.current.dev.set(C);
    });
    act(() => {
      geo.emit(B.lat, B.lng);
    });
    // Still the dev spot; the device moved in the background.
    expect(result.current.state).toMatchObject({ source: 'dev-pin' });
    act(() => {
      result.current.dev.clear();
    });
    expect(result.current.dev.active).toBe(false);
    expect(result.current.state).toEqual({
      status: 'located',
      cell: { precision: 7, geohash: 'u4pruye' },
      source: 'device',
      moved: false,
    });
  });

  it('dev.clear without a device fix falls back to the device status', () => {
    const { result } = renderHook(() => useArea());
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.fail(1);
    });
    act(() => {
      result.current.dev.set(A);
    });
    expect(result.current.state).toMatchObject({ status: 'located', source: 'dev-pin' });
    act(() => {
      result.current.dev.clear();
    });
    expect(result.current.state).toEqual({ status: 'denied' });
  });

  it('a device that becomes denied while located leaves the area denied', () => {
    const { result } = mountLocated();
    act(() => {
      geo.fail(1);
    });
    expect(result.current.state).toEqual({ status: 'denied' });
  });

  it('forgets the committed cell when the device stops watching, then commits afresh', () => {
    const { result } = mountLocated();
    act(() => {
      geo.fail(1);
    });
    act(() => {
      result.current.start();
    });
    act(() => {
      geo.emit(C.lat, C.lng);
    });
    expect(result.current.state).toMatchObject({
      status: 'located',
      cell: { geohash: 'gcpvj0d' },
      moved: false,
    });
  });

  it('never exposes coordinates in its state', () => {
    const { result } = mountLocated();
    act(() => {
      result.current.dev.set(B);
    });
    const json = JSON.stringify(result.current.state);
    expect(json).not.toContain('57.6');
    expect(json).not.toContain('10.4');
    expect(json).not.toMatch(/lat|lng/i);
  });

  it('dev.cell is null, then the cell after set (same ref on a same-cell set), then null after clear', () => {
    const { result } = mountLocated();
    expect(result.current.dev.cell).toBeNull();
    act(() => {
      result.current.dev.set(B);
    });
    const cell = result.current.dev.cell;
    expect(cell).toEqual({ precision: 7, geohash: 'u4pruye' });
    const dev = result.current.dev;
    act(() => {
      result.current.dev.set({ lat: 57.6491, lng: 10.4088 });
    });
    expect(result.current.dev.cell).toBe(cell);
    expect(result.current.dev).toBe(dev);
    act(() => {
      result.current.dev.clear();
    });
    expect(result.current.dev.cell).toBeNull();
  });
});
