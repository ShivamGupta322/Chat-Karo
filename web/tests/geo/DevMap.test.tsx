import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevMap } from '../../src/geo/DevMap';
import { DEV_MAP_TEXT } from '../../src/geo/devLocationText';
import { decodeGeohashBounds } from '../../src/geo/geohash';
import { fakeLeaflet, resetFakeLeaflet } from '../helpers/fakeReactLeaflet';

vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('react-leaflet', async () => (await import('../helpers/fakeReactLeaflet')).createFakeReactLeaflet());

const CELL_D = { precision: 7 as const, geohash: 'u4pruyd' };
const CELL_E = { precision: 7 as const, geohash: 'u4pruye' };
const CELL_C = { precision: 7 as const, geohash: 'gcpvj0d' };
const TILES = 'https://tile.example.org/{z}/{x}/{y}.png';

function centerOf(geohash: string): [number, number] {
  const r = decodeGeohashBounds(geohash);
  if (!r.ok) throw new Error('bad geohash');
  return [(r.bounds.south + r.bounds.north) / 2, (r.bounds.west + r.bounds.east) / 2];
}

beforeEach(() => {
  resetFakeLeaflet();
});

describe('DevMap', () => {
  it('centres on the dev cell when set, at zoom 16, with the wheel off', () => {
    render(<DevMap tileUrl={TILES} cell={CELL_D} onPick={vi.fn()} />);
    const map = screen.getByTestId('map');
    expect(JSON.parse(map.dataset.center ?? '[]')).toEqual(centerOf('u4pruyd'));
    expect(map.dataset.zoom).toBe('16');
    expect(fakeLeaflet.container.props.scrollWheelZoom).toBe(false);
  });

  it('centres on test spot A (its cell centre area) when no cell is set, and draws no rectangle', () => {
    render(<DevMap tileUrl={TILES} cell={null} onPick={vi.fn()} />);
    expect(JSON.parse(screen.getByTestId('map').dataset.center ?? '[]')).toEqual([57.64911, 10.40744]);
    expect(fakeLeaflet.rectangle).toBeNull();
  });

  it('draws exactly the cell box with the accent token classes', () => {
    render(<DevMap tileUrl={TILES} cell={CELL_E} onPick={vi.fn()} />);
    const r = decodeGeohashBounds('u4pruye');
    if (!r.ok) throw new Error('bad geohash');
    const { south, west, north, east } = r.bounds;
    expect(fakeLeaflet.rectangle?.bounds).toEqual([
      [south, west],
      [north, east],
    ]);
    expect(fakeLeaflet.rectangle?.pathOptions.className).toContain('stroke-accent');
  });

  it('passes the tile URL and the fixed attribution to the tile layer', () => {
    render(<DevMap tileUrl={TILES} cell={null} onPick={vi.fn()} />);
    expect(fakeLeaflet.tile).toEqual({ url: TILES, attribution: DEV_MAP_TEXT.attribution });
  });

  it('a click calls onPick with the clicked lat and a wrapped lng', () => {
    const onPick = vi.fn();
    render(<DevMap tileUrl={TILES} cell={null} onPick={onPick} />);
    fakeLeaflet.handlers.click?.({ latlng: { lat: 57.64911, lng: 370.4087 } });
    expect(onPick).toHaveBeenCalledTimes(1);
    const point = onPick.mock.calls[0]?.[0] as { lat: number; lng: number };
    expect(point.lat).toBe(57.64911);
    expect(point.lng).toBeCloseTo(10.4087, 6);
  });

  it('labels the map container and describes it by the hint', () => {
    render(<DevMap tileUrl={TILES} cell={null} onPick={vi.fn()} />);
    const hint = screen.getByText(DEV_MAP_TEXT.hint);
    expect(hint.tagName).toBe('FIGCAPTION');
    expect(fakeLeaflet.mapEl.getAttribute('role')).toBe('region');
    expect(fakeLeaflet.mapEl.getAttribute('aria-label')).toBe(DEV_MAP_TEXT.label);
    expect(fakeLeaflet.mapEl.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('recentres once when a new cell is off screen, and not when it is visible', () => {
    fakeLeaflet.contains = vi.fn(() => false);
    const { rerender } = render(<DevMap tileUrl={TILES} cell={CELL_D} onPick={vi.fn()} />);
    fakeLeaflet.setView.mockClear();
    rerender(<DevMap tileUrl={TILES} cell={CELL_C} onPick={vi.fn()} />);
    expect(fakeLeaflet.setView).toHaveBeenCalledTimes(1);
    expect(fakeLeaflet.setView).toHaveBeenCalledWith(centerOf('gcpvj0d'), 16);

    fakeLeaflet.contains = vi.fn(() => true);
    fakeLeaflet.setView.mockClear();
    rerender(<DevMap tileUrl={TILES} cell={CELL_E} onPick={vi.fn()} />);
    expect(fakeLeaflet.setView).not.toHaveBeenCalled();
  });
});
