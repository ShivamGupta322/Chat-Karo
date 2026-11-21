import { describe, expect, it } from 'vitest';
import { DEV_SLOT_WARNING, readDevIdentitySlot } from '../../src/api/devIdentitySlot';

describe('readDevIdentitySlot', () => {
  it.each(['', '?x=1'])('%j means no slot and not invalid', (s) => {
    expect(readDevIdentitySlot(s)).toEqual({ slot: null, invalid: false });
  });

  it.each([
    ['?identity=b', 'b'],
    ['?identity=abc123', 'abc123'],
    [`?identity=${'a'.repeat(16)}`, 'a'.repeat(16)],
  ])('%j selects slot %j', (s, slot) => {
    expect(readDevIdentitySlot(s)).toEqual({ slot, invalid: false });
  });

  it.each(['?identity=', '?identity=B', `?identity=${'a'.repeat(17)}`, '?identity=a-b', '?identity=%20'])(
    '%j is invalid',
    (s) => {
      expect(readDevIdentitySlot(s)).toEqual({ slot: null, invalid: true });
    },
  );

  it('uses the first value of a repeated parameter', () => {
    expect(readDevIdentitySlot('?identity=a&identity=b')).toEqual({ slot: 'a', invalid: false });
    expect(readDevIdentitySlot('?identity=B&identity=b')).toEqual({ slot: null, invalid: true });
  });

  it('has a warning that never echoes the value', () => {
    expect(DEV_SLOT_WARNING).toContain('?identity=');
  });
});
