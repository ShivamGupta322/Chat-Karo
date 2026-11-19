import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevLocationPicker } from '../../src/geo/DevLocationPicker';
import { DEV_MAP_TEXT } from '../../src/geo/devLocationText';
import { useArea } from '../../src/geo/useArea';
import { createFakeGeolocation, installGeo, uninstallGeo } from '../helpers/fakeGeolocation';

// A stub in place of the real map: it records that the module was imported and exposes onPick and cell.
const mapState = vi.hoisted(() => ({ imported: false, throwOnRender: false }));
vi.mock('../../src/geo/DevMap', () => {
  mapState.imported = true;
  return {
    DevMap: (props: {
      cell: { geohash: string } | null;
      onPick: (p: { lat: number; lng: number }) => void;
    }): React.JSX.Element => {
      if (mapState.throwOnRender) throw new Error('map exploded');
      return (
        <div data-testid="map-stub" data-cell={props.cell === null ? '' : props.cell.geohash}>
          <button
            type="button"
            onClick={() => {
              props.onPick({ lat: 57.64911, lng: 10.4087 });
            }}
          >
            stub pick
          </button>
        </div>
      );
    },
  };
});

const TILES = 'https://tile.example.org/{z}/{x}/{y}.png';

beforeEach(() => {
  mapState.imported = false;
  mapState.throwOnRender = false;
  installGeo({ geolocation: createFakeGeolocation(), permissions: null, secure: true });
});

afterEach(() => {
  uninstallGeo();
});

function Harness({ mapTileUrl = null }: { mapTileUrl?: string | null }): React.JSX.Element {
  const area = useArea();
  return (
    <>
      <output data-testid="area">
        {area.state.status === 'located' ? area.state.cell.geohash : area.state.status}
      </output>
      <output data-testid="state">{JSON.stringify(area.state)}</output>
      <DevLocationPicker override={area.dev} mapTileUrl={mapTileUrl} />
    </>
  );
}

function open(): void {
  const details = document.querySelector('details');
  if (details) details.open = true;
}

const areaText = (): string => screen.getByTestId('area').textContent;

describe('DevLocationPicker', () => {
  it('has a summary and three presets', () => {
    render(<Harness />);
    expect(screen.getByText('Test locations (dev)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Test spot/ })).toHaveLength(3);
  });

  it.each([
    ['Test spot A', 'u4pruyd'],
    ['Test spot B (next to A)', 'u4pruye'],
    ['Test spot C (far away)', 'gcpvj0d'],
  ])('preset %s selects %s', async (name, geohash) => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    open();
    await user.click(screen.getByRole('button', { name }));
    expect(areaText()).toBe(geohash);
  });

  it('labels both inputs and turns autocomplete off', () => {
    render(<Harness />);
    open();
    for (const label of ['Latitude', 'Longitude']) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('inputmode', 'decimal');
      expect(input).toHaveAttribute('spellcheck', 'false');
    }
  });

  it('applies valid manual input and clears the fields', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    open();
    await user.type(screen.getByLabelText('Latitude'), '57.64911');
    await user.type(screen.getByLabelText('Longitude'), '10.40744');
    await user.click(screen.getByRole('button', { name: 'Use this spot' }));
    expect(areaText()).toBe('u4pruyd');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Latitude')).toHaveValue('');
  });

  it.each([
    ['', ''],
    ['abc', '10'],
    ['91', '10'],
    ['10', '181'],
    ['1e2', '10'],
  ])('rejects (%s, %s) with an alert and leaves the area unchanged', async (lat, lng) => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    open();
    const before = areaText();
    if (lat) await user.type(screen.getByLabelText('Latitude'), lat);
    if (lng) await user.type(screen.getByLabelText('Longitude'), lng);
    await user.click(screen.getByRole('button', { name: 'Use this spot' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/between -90 and 90/);
    expect(areaText()).toBe(before);
  });

  it('works by keyboard only: Tab to a preset and Enter, then type and Enter to submit', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    open();
    await user.tab(); // preset A
    expect(screen.getByRole('button', { name: 'Test spot A' })).toHaveFocus();
    await user.tab(); // preset B
    await user.keyboard('{Enter}');
    expect(areaText()).toBe('u4pruye');
    await user.tab(); // preset C
    await user.tab(); // latitude
    expect(screen.getByLabelText('Latitude')).toHaveFocus();
    await user.keyboard('51.5074');
    await user.tab();
    await user.keyboard('-0.1278{Enter}');
    expect(areaText()).toBe('gcpvj0d');
  });

  it('shows "Use my real location" only while a test spot is active, and returns to the device', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    open();
    expect(screen.queryByRole('button', { name: 'Use my real location' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test spot A' }));
    const real = screen.getByRole('button', { name: 'Use my real location' });
    await act(async () => {
      real.click();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Use my real location' })).toBeNull();
    expect(areaText()).toBe('idle');
  });

  describe('map', () => {
    const toggle = (openIt: boolean): void => {
      const details = document.querySelector('details');
      if (!details) throw new Error('no details');
      details.open = openIt;
      fireEvent(details, new Event('toggle'));
    };

    it('without a tile URL shows the hint and never loads the map', () => {
      render(<Harness mapTileUrl={null} />);
      toggle(true);
      expect(screen.getByText(DEV_MAP_TEXT.noTiles)).toBeInTheDocument();
      expect(mapState.imported).toBe(false);
    });

    it('does not load the map while the panel is closed', () => {
      render(<Harness mapTileUrl={TILES} />);
      expect(mapState.imported).toBe(false);
      expect(screen.queryByText(DEV_MAP_TEXT.loading)).toBeNull();
    });

    it('loads on open (loading text first) and unmounts on close', async () => {
      render(<Harness mapTileUrl={TILES} />);
      toggle(true);
      expect(screen.getByText(DEV_MAP_TEXT.loading)).toHaveAttribute('role', 'status');
      expect(await screen.findByTestId('map-stub')).toBeInTheDocument();
      toggle(false);
      expect(screen.queryByTestId('map-stub')).toBeNull();
    });

    it('a map click selects that cell like a preset, clears the fields, and keeps coordinates out of state', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Harness mapTileUrl={TILES} />);
      toggle(true);
      await user.type(screen.getByLabelText('Latitude'), '12');
      await user.click(await screen.findByRole('button', { name: 'stub pick' }));
      expect(areaText()).toBe('u4pruye');
      const state = screen.getByTestId('state').textContent;
      expect(state).toContain('dev-pin');
      expect(state).not.toContain('57.649');
      expect(state).not.toContain('10.408');
      expect(screen.getByLabelText('Latitude')).toHaveValue('');
      expect(screen.getByTestId('map-stub')).toHaveAttribute('data-cell', 'u4pruye');
    });

    it('a map click clears an old invalid alert', async () => {
      const user = userEvent.setup({ delay: null });
      render(<Harness mapTileUrl={TILES} />);
      toggle(true);
      await user.click(screen.getByRole('button', { name: 'Use this spot' }));
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: 'stub pick' }));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the failure text when the map throws, and the presets keep working', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mapState.throwOnRender = true;
      const user = userEvent.setup({ delay: null });
      render(<Harness mapTileUrl={TILES} />);
      toggle(true);
      expect(await screen.findByText(DEV_MAP_TEXT.failed)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Test spot A' }));
      expect(areaText()).toBe('u4pruyd');
      spy.mockRestore();
    });

    it('never loads the map when DEV is false (production gate)', async () => {
      vi.stubEnv('DEV', false);
      vi.resetModules();
      try {
        const { DevLocationPicker: ProdPicker } = await import('../../src/geo/DevLocationPicker');
        mapState.imported = false;
        const override = {
          active: false,
          cell: null,
          set: () => ({ ok: true as const }),
          clear: () => undefined,
        };
        render(<ProdPicker override={override} mapTileUrl={TILES} />);
        toggle(true);
        expect(mapState.imported).toBe(false);
        expect(screen.queryByText(DEV_MAP_TEXT.loading)).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
