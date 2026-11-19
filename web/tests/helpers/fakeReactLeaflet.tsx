import type { ReactNode } from 'react';
import { vi } from 'vitest';

type ClickHandler = (e: { latlng: { lat: number; lng: number } }) => void;

/** Everything the fake records. Reset with resetFakeLeaflet() in beforeEach. */
export const fakeLeaflet = {
  container: {
    props: {} as Record<string, unknown>,
  },
  tile: null as { url: string; attribution: string } | null,
  rectangle: null as { bounds: unknown; pathOptions: { className?: string } } | null,
  handlers: {} as { click?: ClickHandler },
  contains: vi.fn(() => true),
  setView: vi.fn(),
  mapEl: document.createElement('div'),
};

export function resetFakeLeaflet(): void {
  fakeLeaflet.container.props = {};
  fakeLeaflet.tile = null;
  fakeLeaflet.rectangle = null;
  fakeLeaflet.handlers = {};
  fakeLeaflet.contains = vi.fn(() => true);
  fakeLeaflet.setView = vi.fn();
  fakeLeaflet.mapEl = document.createElement('div');
  fakeMap = makeMap();
}

function makeMap(): object {
  return {
    getContainer: () => fakeLeaflet.mapEl,
    getBounds: () => ({ contains: fakeLeaflet.contains }),
    setView: fakeLeaflet.setView,
    getZoom: () => 16,
  };
}
let fakeMap: object = makeMap();

/** Use inside `vi.mock('react-leaflet', async () => (await import('../helpers/fakeReactLeaflet')).createFakeReactLeaflet())`. */
export function createFakeReactLeaflet(): Record<string, unknown> {
  return {
    MapContainer: (props: { center: unknown; zoom: unknown; children?: ReactNode }): React.JSX.Element => {
      fakeLeaflet.container.props = props;
      return (
        <div data-testid="map" data-center={JSON.stringify(props.center)} data-zoom={String(props.zoom)}>
          {props.children}
        </div>
      );
    },
    TileLayer: (props: { url: string; attribution: string }): null => {
      fakeLeaflet.tile = { url: props.url, attribution: props.attribution };
      return null;
    },
    Rectangle: (props: { bounds: unknown; pathOptions: { className?: string } }): null => {
      fakeLeaflet.rectangle = { bounds: props.bounds, pathOptions: props.pathOptions };
      return null;
    },
    useMapEvents: (handlers: { click?: ClickHandler }): object => {
      fakeLeaflet.handlers = handlers;
      return fakeMap;
    },
    useMap: (): object => fakeMap,
  };
}
