import { useId, useRef, useState, type FormEvent } from 'react';
import { DEV_LOCATION_TEXT } from './devLocationText';
import { DEV_PRESETS } from './devPresets';
import type { DevOverride } from './useArea';

const PRESET_LABEL = {
  A: DEV_LOCATION_TEXT.presetA,
  B: DEV_LOCATION_TEXT.presetB,
  C: DEV_LOCATION_TEXT.presetC,
} as const;

const INPUT =
  'w-full min-w-0 rounded-lg border border-field bg-surface px-3 py-2 text-ink disabled:bg-surface-sunken';
const BUTTON =
  'rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken';

/** Plain decimal numbers only; Number('') is 0, so empty input must be rejected explicitly. */
function parseDecimal(raw: string): number | null {
  const text = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  return Number(text);
}

/**
 * Dev-only test locations. Lives in geo/ because it handles raw numbers: they exist only in the two input
 * fields' state and are cleared once a spot has been applied. Only a Cell reaches the rest of the app.
 */
export function DevLocationPicker({ override }: { override: DevOverride }): React.JSX.Element {
  const latId = useId();
  const lngId = useId();
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [invalid, setInvalid] = useState(false);
  const firstPreset = useRef<HTMLButtonElement>(null);

  const apply = (point: { lat: number; lng: number }): boolean => {
    const res = override.set(point);
    setInvalid(!res.ok);
    return res.ok;
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const la = parseDecimal(lat);
    const ln = parseDecimal(lng);
    if (la === null || ln === null || !apply({ lat: la, lng: ln })) {
      setInvalid(true);
      return;
    }
    setLat('');
    setLng('');
  };

  return (
    <details className="rounded-2xl border border-line bg-surface p-3 shadow-sm sm:p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {DEV_LOCATION_TEXT.summary}
      </summary>
      <div className="mt-3 grid gap-3">
        <div className="flex flex-wrap gap-2">
          {DEV_PRESETS.map((p, i) => (
            <button
              key={p.id}
              ref={i === 0 ? firstPreset : undefined}
              type="button"
              className={BUTTON}
              onClick={() => {
                if (apply(p.point)) {
                  setLat('');
                  setLng('');
                }
              }}
            >
              {PRESET_LABEL[p.id]}
            </button>
          ))}
        </div>
        <form onSubmit={onSubmit} className="grid gap-2 text-sm" noValidate>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1">
              <label htmlFor={latId} className="font-medium">
                {DEV_LOCATION_TEXT.latitude}
              </label>
              <input
                id={latId}
                className={INPUT}
                value={lat}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setLat(e.target.value);
                }}
              />
            </div>
            <div className="grid min-w-0 gap-1">
              <label htmlFor={lngId} className="font-medium">
                {DEV_LOCATION_TEXT.longitude}
              </label>
              <input
                id={lngId}
                className={INPUT}
                value={lng}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setLng(e.target.value);
                }}
              />
            </div>
          </div>
          <div>
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-strong"
            >
              {DEV_LOCATION_TEXT.use}
            </button>
          </div>
          {invalid && (
            <p role="alert" className="m-0 text-danger">
              {DEV_LOCATION_TEXT.invalid}
            </p>
          )}
        </form>
        {override.active && (
          <div>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                override.clear();
                setInvalid(false);
                firstPreset.current?.focus();
              }}
            >
              {DEV_LOCATION_TEXT.useReal}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
