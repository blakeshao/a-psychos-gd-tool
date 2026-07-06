// The expression compiler backs a user-facing param (Grid's `expression`
// distribution) — bad input must throw at compile (callers fall back to
// uniform), and evaluation must stay pure and total (NaN, never exceptions).

import { describe, expect, it } from 'vitest';
import { compileExpr } from './expr';

const ev = (src: string, scope: Record<string, number> = {}) => compileExpr(src)(scope);

describe('compileExpr', () => {
  it('arithmetic with standard precedence and parens', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('.5 + 0.25')).toBe(0.75);
  });

  it('power is right-associative and binds under unary minus', () => {
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // 2^(3^2), not (2^3)^2
    expect(ev('-2 ^ 2')).toBe(-4); // -(2^2), math convention
    expect(ev('2 ^ -1')).toBe(0.5);
  });

  it('variables come from the scope; constants are built in', () => {
    expect(ev('t * n + i', { t: 0.5, n: 4, i: 1 })).toBe(3);
    expect(ev('cos(tau)')).toBeCloseTo(1, 12);
    expect(ev('phi ^ 2 - phi')).toBeCloseTo(1, 12); // φ² = φ + 1
    expect(ev('log(e)')).toBeCloseTo(1, 12);
  });

  it('functions: one- and two-argument forms', () => {
    expect(ev('sin(pi / 2)')).toBeCloseTo(1, 12);
    expect(ev('max(2, min(5, 3))')).toBe(3);
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('mod(-1, 4)')).toBe(3); // true modulo, unlike JS %
    expect(ev('floor(1.9) + ceil(0.1)')).toBe(2);
  });

  it('throws on malformed input and unknown names', () => {
    expect(() => compileExpr('nope(')).toThrow();
    expect(() => compileExpr('1 +')).toThrow();
    expect(() => compileExpr('foo * 2')).toThrow(/unknown name/);
    expect(() => compileExpr('blorp(1)')).toThrow(/unknown function/);
    expect(() => compileExpr('min(1)')).toThrow(/takes 2/);
    expect(() => compileExpr('1 2')).toThrow();
    expect(() => compileExpr('')).toThrow();
  });

  it('domain errors evaluate to NaN/Infinity instead of throwing', () => {
    expect(ev('sqrt(-1)')).toBeNaN();
    expect(ev('1 / 0')).toBe(Infinity);
  });
});
