// Dev only (main.tsx guards the call with a literal import.meta.env.DEV): pick a separate stored identity per tab.
export const DEV_SLOT_WARNING =
  'Nearby (dev): ignoring an invalid dev identity slot; use ?identity= with 1-16 of a-z 0-9.';

export function readDevIdentitySlot(search: string): { slot: string | null; invalid: boolean } {
  const raw = new URLSearchParams(search).get('identity');
  if (raw === null) return { slot: null, invalid: false };
  if (/^[a-z0-9]{1,16}$/.test(raw)) return { slot: raw, invalid: false };
  return { slot: null, invalid: true };
}
