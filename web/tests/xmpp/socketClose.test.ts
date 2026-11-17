import { describe, expect, it } from 'vitest';
import { describeSocketClose } from '../../src/xmpp/socketClose';

const base = {
  code: 1006,
  reason: '',
  wasClean: false,
  visibility: 'visible' as DocumentVisibilityState,
  hiddenForMs: null,
  msSinceVisible: null,
};

describe('describeSocketClose', () => {
  it('returns exactly the documented keys', () => {
    const log = describeSocketClose(base);
    expect(Object.keys(log).sort()).toEqual(
      ['code', 'hidden', 'hiddenForMs', 'msSinceVisible', 'reason', 'wasClean'].sort(),
    );
  });

  it('hidden is true only for the hidden visibility state', () => {
    expect(describeSocketClose({ ...base, visibility: 'hidden' }).hidden).toBe(true);
    expect(describeSocketClose({ ...base, visibility: 'visible' }).hidden).toBe(false);
  });

  it('cuts a long reason to 123 chars and passes the other fields through', () => {
    const log = describeSocketClose({ ...base, reason: 'x'.repeat(500), hiddenForMs: 42, msSinceVisible: 7 });
    expect(log.reason).toHaveLength(123);
    expect(log.code).toBe(1006);
    expect(log.wasClean).toBe(false);
    expect(log.hiddenForMs).toBe(42);
    expect(log.msSinceVisible).toBe(7);
  });
});
