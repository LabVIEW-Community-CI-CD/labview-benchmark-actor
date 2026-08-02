// A small, pure module used as the coverage-lift TARGET: several exported functions with distinct branches,
// so a thorough proposed test reaches high line/function coverage while a weak one does not. No side effects
// (safe to import + execute in the coverage measurement). Deterministic fixture for verify-coverage-lift.mjs.

export function classify(n) {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'zero';
}

export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

export function sum(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

export function fib(n) {
  if (n < 2) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i += 1) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}
