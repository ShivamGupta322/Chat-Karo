import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevLocationPicker } from '../../src/geo/DevLocationPicker';
import { useArea } from '../../src/geo/useArea';
import { createFakeGeolocation, installGeo, uninstallGeo } from '../helpers/fakeGeolocation';

beforeEach(() => {
  installGeo({ geolocation: createFakeGeolocation(), permissions: null, secure: true });
});

afterEach(() => {
  uninstallGeo();
});

function Harness(): React.JSX.Element {
  const area = useArea();
  return (
    <>
      <output data-testid="area">
        {area.state.status === 'located' ? area.state.cell.geohash : area.state.status}
      </output>
      <DevLocationPicker override={area.dev} />
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
});
