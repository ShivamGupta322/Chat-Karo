import { describe, expect, it } from 'vitest';
import { nextScrollTop } from '../../src/components/scrollAnchor';

const base = {
  prev: { firstKey: 'm-a', firstTop: 48 },
  firstKeyNow: 'm-new',
  prevKeyTopNow: 168,
  earlierJustLoaded: true,
  stick: false,
  scrollTop: 10,
  scrollHeight: 1000,
};

describe('nextScrollTop', () => {
  it('keeps the old first row in place after an earlier page lands above it', () => {
    expect(nextScrollTop(base)).toBe(10 + 120);
  });

  it('applies a negative delta when the block above shrank', () => {
    expect(nextScrollTop({ ...base, prevKeyTopNow: 8, scrollTop: 100 })).toBe(100 - 40);
  });

  it('stays anchored, not at the bottom, even when stuck to the bottom', () => {
    expect(nextScrollTop({ ...base, stick: true })).toBe(130);
  });

  it('follows the bottom for an append-only render while stuck', () => {
    expect(
      nextScrollTop({
        ...base,
        firstKeyNow: 'm-a',
        prevKeyTopNow: 48,
        earlierJustLoaded: false,
        stick: true,
      }),
    ).toBe(1000);
  });

  it('leaves the position alone when not stuck and no earlier page landed', () => {
    expect(nextScrollTop({ ...base, earlierJustLoaded: false, stick: false })).toBeNull();
  });

  it('a prepend without earlierJustLoaded falls back to stick or null', () => {
    expect(nextScrollTop({ ...base, earlierJustLoaded: false, stick: true })).toBe(1000);
    expect(nextScrollTop({ ...base, earlierJustLoaded: false, stick: false })).toBeNull();
  });

  it('falls back to stick or null when the previous first row is gone', () => {
    expect(nextScrollTop({ ...base, prevKeyTopNow: null, stick: true })).toBe(1000);
    expect(nextScrollTop({ ...base, prevKeyTopNow: null, stick: false })).toBeNull();
  });

  it('falls back to stick or null when there was no previous first row', () => {
    const prev = { firstKey: null, firstTop: 0 };
    expect(nextScrollTop({ ...base, prev, stick: true })).toBe(1000);
    expect(nextScrollTop({ ...base, prev, stick: false })).toBeNull();
  });

  it('does not move when the first row is unchanged after an earlier load (for example a failure)', () => {
    expect(nextScrollTop({ ...base, firstKeyNow: 'm-a', stick: false })).toBeNull();
  });
});
