import { describe, expect, it } from 'vitest';
import { validateNickname } from '../../src/api/nickname';

describe('validateNickname', () => {
  it.each(['ab', 'A1', 'a_b-c', 'a'.repeat(20)])('accepts %j', (n) => {
    expect(validateNickname(n)).toEqual({ ok: true, value: n });
  });

  it('trims the input', () => {
    expect(validateNickname('  Alice ')).toEqual({ ok: true, value: 'Alice' });
  });

  it.each(['', '   '])('reports %j as empty', (n) => {
    expect(validateNickname(n)).toEqual({ ok: false, error: 'empty' });
  });

  it.each(['a', 'a'.repeat(21), '_ab', '-ab', 'a b', 'ä1', 'a.b'])('reports %j as invalid', (n) => {
    expect(validateNickname(n)).toEqual({ ok: false, error: 'invalid' });
  });
});
