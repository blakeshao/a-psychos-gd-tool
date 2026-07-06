// Tiny arithmetic expression compiler for user-facing params (Grid's
// `expression` distribution). Deliberately not `new Function`: documents travel
// between machines, and a param that executes arbitrary JS on open is an
// injection hazard. The grammar is small — numbers, + - * / % ^ (right-assoc),
// parens, a fixed set of math functions, named constants, and caller-declared
// variables. Compilation returns a pure closure, so cooks stay deterministic.

export type Scope = Record<string, number>;
export type CompiledExpr = (scope: Scope) => number;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
};

const FUNCTIONS: Record<string, { arity: 1 | 2; fn: (a: number, b: number) => number }> = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  abs: { arity: 1, fn: Math.abs },
  sqrt: { arity: 1, fn: Math.sqrt },
  exp: { arity: 1, fn: Math.exp },
  log: { arity: 1, fn: Math.log },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  sign: { arity: 1, fn: Math.sign },
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  pow: { arity: 2, fn: Math.pow },
  mod: { arity: 2, fn: (a, b) => (((a % b) + b) % b) }, // true modulo — wraps negatives
};

type Node = (scope: Scope) => number;

/**
 * Compile `src` into a pure evaluator. Throws Error (with position) on any
 * syntax problem or unknown name — callers catch and fall back. Runtime never
 * throws; domain errors (log of a negative, division by zero) surface as
 * NaN/Infinity for the caller's clamping to handle.
 */
export function compileExpr(src: string, vars: readonly string[] = ['t', 'i', 'n']): CompiledExpr {
  let pos = 0;

  function fail(msg: string): never {
    throw new Error(`${msg} at ${pos} in "${src}"`);
  }
  function peek(): string {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
    return src[pos] ?? '';
  }
  function eat(ch: string): void {
    if (peek() !== ch) fail(`expected '${ch}'`);
    pos++;
  }

  // expr := term (('+'|'-') term)*
  function parseExpr(): Node {
    let left = parseTerm();
    for (;;) {
      const ch = peek();
      if (ch !== '+' && ch !== '-') return left;
      pos++;
      const l = left, r = parseTerm();
      left = ch === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
  }

  // term := unary (('*'|'/'|'%') unary)*
  function parseTerm(): Node {
    let left = parseUnary();
    for (;;) {
      const ch = peek();
      if (ch !== '*' && ch !== '/' && ch !== '%') return left;
      pos++;
      const l = left, r = parseUnary();
      left = ch === '*' ? (s) => l(s) * r(s) : ch === '/' ? (s) => l(s) / r(s) : (s) => l(s) % r(s);
    }
  }

  // unary := '-' unary | power — so -2^2 is -(2^2), matching math convention
  function parseUnary(): Node {
    if (peek() !== '-') return parsePower();
    pos++;
    const operand = parseUnary();
    return (s) => -operand(s);
  }

  // power := atom ('^' unary)? — right-assoc: 2^3^2 is 2^(3^2)
  function parsePower(): Node {
    const base = parseAtom();
    if (peek() !== '^') return base;
    pos++;
    const exp = parseUnary();
    return (s) => Math.pow(base(s), exp(s));
  }

  // atom := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
  function parseAtom(): Node {
    const ch = peek();
    if (ch === '(') {
      pos++;
      const inner = parseExpr();
      eat(')');
      return inner;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(pos));
      if (!m) fail('bad number');
      pos += m[0].length;
      const v = Number(m[0]);
      return () => v;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const name = /^[a-zA-Z_]+/.exec(src.slice(pos))![0];
      pos += name.length;
      if (peek() === '(') {
        const f = FUNCTIONS[name] ?? fail(`unknown function '${name}'`);
        pos++;
        const args: Node[] = [parseExpr()];
        while (peek() === ',') {
          pos++;
          args.push(parseExpr());
        }
        eat(')');
        if (args.length !== f.arity) fail(`${name} takes ${f.arity} argument${f.arity === 1 ? '' : 's'}`);
        const [a, b] = args;
        return f.arity === 1 ? (s) => f.fn(a(s), 0) : (s) => f.fn(a(s), b(s));
      }
      if (name in CONSTANTS) {
        const v = CONSTANTS[name];
        return () => v;
      }
      if (vars.includes(name)) return (s) => s[name] ?? 0;
      fail(`unknown name '${name}'`);
    }
    fail(ch ? `unexpected '${ch}'` : 'unexpected end of expression');
  }

  const root = parseExpr();
  if (peek() !== '') fail(`unexpected '${src[pos]}'`);
  return root;
}
