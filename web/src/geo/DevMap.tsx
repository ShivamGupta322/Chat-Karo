import 'leaflet/dist/leaflet.css';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import { useEffect, useId } from 'react';
import { MapContainer, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { Cell } from './cell';
import { DEV_MAP_TEXT } from './devLocationText';
import { DEV_PRESETS } from './devPresets';
import { decodeGeohashBounds, wrapLng } from './geohash';
import type { GeoPoint } from './useArea';

export interface DevMapProps {
  tileUrl: string;
  cell: Cell | null;
  onPick: (point: GeoPoint) => void;
}

interface CellBox {
  bounds: LatLngBoundsExpression;
  center: LatLngExpression;
}

function boxOf(cell: Cell | null): CellBox | null {
  if (cell === null) return null;
  const res = decodeGeohashBounds(cell.geohash);
  if (!res.ok) return null;
  const { south, west, north, east } = res.bounds;
  return {
    bounds: [
      [south, west],
      [north, east],
    ],
    center: [(south + north) / 2, (west + east) / 2],
  };
}

/**
 * Click handling and keeping the shaded cell in view. No state: a clicked point goes straight to onPick
 * and is never stored here.
 */
function MapBehaviour({
  hintId,
  geohash,
  onPick,
}: {
  hintId: string;
  geohash: string | null;
  onPick: (point: GeoPoint) => void;
}): null {
  const map = useMap();
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lng: wrapLng(e.latlng.lng) });
    },
  });

  useEffect(() => {
    if (geohash === null) return;
    const res = decodeGeohashBounds(geohash);
    if (!res.ok) return;
    const { south, west, north, east } = res.bounds;
    // Follow spots chosen elsewhere (presets, keyboard) when their cell is not fully on screen.
    if (!map.getBounds().contains([
      [south, west],
      [north, east],
    ])) {
      map.setView([(south + north) / 2, (west + east) / 2], map.getZoom());
    }
  }, [map, geohash]);

  useEffect(() => {
    const el = map.getContainer();
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', DEV_MAP_TEXT.label);
    el.setAttribute('aria-describedby', hintId);
  }, [map, hintId]);

  return null;
}

/**
 * Dev-only Leaflet map. The only file that imports react-leaflet. It draws the whole cell the user is in,
 * never the clicked point, and is centred on the dev cell or test spot A, never on the device.
 */
export function DevMap({ tileUrl, cell, onPick }: DevMapProps): React.JSX.Element {
  const hintId = useId();
  const box = boxOf(cell);
  // Test spot A when nothing is chosen yet (never the device location).
  const [spotA] = DEV_PRESETS;
  const center: LatLngExpression = box
    ? box.center
    : spotA
      ? [spotA.point.lat, spotA.point.lng]
      : [0, 0];

  return (
    <figure className="m-0 grid gap-2">
      <figcaption id={hintId} className="text-sm text-ink-muted">
        {DEV_MAP_TEXT.hint}
      </figcaption>
      <div className="isolate overflow-hidden rounded-lg border border-line">
        <MapContainer
          center={center}
          zoom={16}
          minZoom={3}
          maxZoom={19}
          scrollWheelZoom={false}
          className="h-48 w-full md:h-56"
        >
          <TileLayer url={tileUrl} attribution={DEV_MAP_TEXT.attribution} maxZoom={19} />
          {box && (
            <Rectangle
              bounds={box.bounds}
              pathOptions={{ className: 'stroke-accent fill-accent', weight: 2, fillOpacity: 0.15 }}
            />
          )}
          <MapBehaviour
            hintId={hintId}
            geohash={cell === null ? null : cell.geohash}
            onPick={onPick}
          />
        </MapContainer>
      </div>
    </figure>
  );
}
