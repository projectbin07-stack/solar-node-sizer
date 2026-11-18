// Seeded pseudo-random numbers so that every run can be reproduced exactly.

/**
 * @typedef {object} Rng
 * @property {() => number} next Uniform sample in [0, 1).
 * @property {() => number} gaussian Standard normal sample (mean 0, std 1).
 */

/**
 * Create a mulberry32 generator. Same seed, same sequence, on every platform.
 * @param {number} seed Any number; only the low 32 bits are used.
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = seed >>> 0;
  /** @type {number | null} */
  let spare = null;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller transform; the second value of each pair is kept for the next call.
  const gaussian = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = 1 - next(); // (0, 1], so the log is finite
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };

  return { next, gaussian };
}
