import assert from "node:assert/strict";

/**
 * Assert |actual - expected| <= tol.
 * @param {number} actual
 * @param {number} expected
 * @param {number} tol
 * @param {string} [what]
 */
export function near(actual, expected, tol, what = "value") {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected} +/- ${tol}, got ${actual}`,
  );
}

/**
 * Assert a relative error no larger than rel.
 * @param {number} actual
 * @param {number} expected
 * @param {number} rel
 * @param {string} [what]
 */
export function nearRel(actual, expected, rel, what = "value") {
  near(actual, expected, Math.abs(expected) * rel, what);
}
