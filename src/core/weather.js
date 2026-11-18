// Synthetic weather: daily cloudiness as a seeded random process around
// monthly means, and air temperature as a monthly mean plus a daily cycle.
//
// The presets were fitted with scripts/fit-climate.js to ONE year (2020) of
// PVGIS hourly data on a horizontal plane for the named place. One year is
// not a climatology: monsoon onset, cloud amount and heat waves vary a lot
// from year to year. Treat every preset as illustrative and use a PVGIS file
// for your own site when the answer matters.

import { createRng } from "./rng.js";

/**
 * @typedef {object} Climate
 * @property {string} id
 * @property {string} label
 * @property {string} source where the numbers come from
 * @property {number[]} clearIndex 12 monthly means of measured / Haurwitz clear-sky GHI
 * @property {number[]} clearIndexStd 12 monthly standard deviations of the daily index
 * @property {number} persistence lag-1 autocorrelation of daily anomalies (0..0.95)
 * @property {number[]} tMean 12 monthly mean air temperatures, degC
 * @property {number[]} tHalfRange 12 monthly mean half diurnal ranges, K
 */

const FIT = "fitted to PVGIS 2020 hourly data (one year, horizontal plane); illustrative";

/** @type {Climate[]} */
export const CLIMATES = [
  {
    id: "bengaluru",
    label: "Bengaluru-like (SW monsoon Jun-Sep, NE monsoon Oct-Dec)",
    source: `PVGIS-ERA5 at 12.97 N 77.59 E, ${FIT}`,
    clearIndex: [0.94, 0.96, 0.9, 0.86, 0.81, 0.6, 0.54, 0.52, 0.54, 0.67, 0.69, 0.75],
    clearIndexStd: [0.13, 0.07, 0.11, 0.12, 0.06, 0.11, 0.13, 0.17, 0.14, 0.19, 0.21, 0.25],
    persistence: 0.52,
    tMean: [22, 22.9, 25.3, 26.5, 27.2, 23.6, 22.4, 22.4, 22, 21.9, 21.2, 19.8],
    tHalfRange: [5.8, 6.3, 6.2, 6.1, 5.4, 3.6, 3.1, 3, 3.1, 3.6, 3.8, 4.1],
  },
  {
    id: "mumbai",
    label: "Mumbai-like (heavy SW monsoon Jun-Sep)",
    source: `PVGIS-ERA5 at 19.08 N 72.88 E, ${FIT}`,
    clearIndex: [0.95, 0.95, 0.93, 0.9, 0.84, 0.49, 0.43, 0.34, 0.57, 0.69, 0.89, 0.92],
    clearIndexStd: [0.06, 0.06, 0.05, 0.03, 0.06, 0.14, 0.13, 0.19, 0.17, 0.14, 0.09, 0.14],
    persistence: 0.53,
    tMean: [23.8, 25.6, 26.1, 28.6, 29.6, 27.5, 26.9, 26.4, 27.1, 27.6, 27.3, 25.7],
    tHalfRange: [3.3, 3.8, 3.4, 3, 2.2, 1.4, 1.1, 0.9, 1.5, 2.1, 3.2, 3.5],
  },
  {
    id: "delhi",
    label: "New Delhi-like (hot summer, monsoon Jul-Aug, cool winter)",
    source: `PVGIS-ERA5 at 28.61 N 77.21 E, ${FIT}`,
    clearIndex: [0.86, 0.92, 0.85, 0.88, 0.87, 0.75, 0.62, 0.53, 0.77, 0.94, 0.95, 1],
    clearIndexStd: [0.19, 0.17, 0.14, 0.08, 0.07, 0.08, 0.1, 0.16, 0.1, 0.05, 0.11, 0.07],
    persistence: 0.38,
    tMean: [13.1, 15.9, 19.8, 26.5, 30.5, 31.9, 30.4, 28.7, 29.3, 25.7, 19, 15.1],
    tHalfRange: [5.3, 6.2, 5.8, 6.8, 6.9, 4.9, 3.7, 2.9, 4.4, 7.1, 6.7, 6.7],
  },
  {
    id: "chennai",
    label: "Chennai-like (NE monsoon Oct-Dec)",
    source: `PVGIS-ERA5 at 13.08 N 80.27 E, ${FIT}`,
    clearIndex: [0.86, 0.88, 0.89, 0.84, 0.82, 0.68, 0.61, 0.59, 0.58, 0.69, 0.68, 0.67],
    clearIndexStd: [0.1, 0.08, 0.05, 0.06, 0.1, 0.14, 0.16, 0.15, 0.18, 0.17, 0.23, 0.23],
    persistence: 0.51,
    tMean: [25.7, 26.6, 28, 29.7, 31.3, 31.1, 29.4, 29.3, 28.7, 28.6, 26.9, 26],
    tHalfRange: [2.2, 2.5, 2.5, 2.4, 2.5, 2.9, 2.3, 2.2, 2.2, 2.2, 1.7, 1.7],
  },
  {
    id: "guwahati",
    label: "Guwahati-like (long wet season May-Sep)",
    source: `PVGIS-ERA5 at 26.14 N 91.74 E, ${FIT}`,
    clearIndex: [0.8, 0.76, 0.79, 0.7, 0.56, 0.46, 0.38, 0.52, 0.52, 0.66, 0.88, 0.88],
    clearIndexStd: [0.14, 0.13, 0.13, 0.15, 0.18, 0.15, 0.14, 0.14, 0.17, 0.17, 0.14, 0.1],
    persistence: 0.48,
    tMean: [16.2, 18.7, 22.8, 25.1, 25.4, 26.7, 26.8, 27.7, 26.7, 26, 20.9, 18.1],
    tHalfRange: [4.6, 4.7, 5.8, 5.3, 3.7, 2.5, 2.1, 2.5, 2.6, 3.3, 5.2, 4.8],
  },
  {
    id: "nairobi",
    label: "Nairobi-like (highland, two rainy seasons)",
    source: `PVGIS-SARAH3 at 1.29 S 36.82 E, ${FIT}`,
    clearIndex: [0.78, 0.87, 0.8, 0.7, 0.68, 0.65, 0.54, 0.62, 0.62, 0.67, 0.75, 0.96],
    clearIndexStd: [0.17, 0.15, 0.12, 0.17, 0.18, 0.21, 0.17, 0.2, 0.23, 0.21, 0.17, 0.1],
    persistence: 0.4,
    tMean: [19.1, 19.6, 20, 19.3, 18.9, 18.1, 17.3, 17.9, 18.3, 19.8, 19.1, 19.6],
    tHalfRange: [4.1, 4.8, 4.3, 3.7, 4, 4.1, 4.2, 4.8, 4.9, 5, 4.3, 5.4],
  },
  {
    id: "berlin",
    label: "Berlin-like (high latitude, dark winter)",
    source: `PVGIS-SARAH3 at 52.52 N 13.41 E, ${FIT}`,
    clearIndex: [0.64, 0.53, 0.69, 0.86, 0.68, 0.65, 0.65, 0.72, 0.74, 0.52, 0.59, 0.62],
    clearIndexStd: [0.27, 0.23, 0.3, 0.19, 0.22, 0.21, 0.19, 0.21, 0.26, 0.19, 0.27, 0.25],
    persistence: 0.23,
    tMean: [4.1, 5.8, 5.1, 10.1, 12.9, 19.3, 18.8, 22.4, 16.2, 11.5, 7.3, 3.3],
    tHalfRange: [2.3, 2.5, 4, 5.6, 4.9, 4.8, 4.4, 4.7, 4.7, 2.6, 2.3, 2],
  },
  {
    id: "clear",
    label: "Always clear (hand-set: upper bound, no clouds)",
    source: "hand-set, not fitted to data",
    clearIndex: Array(12).fill(0.95),
    clearIndexStd: Array(12).fill(0),
    persistence: 0,
    tMean: Array(12).fill(25),
    tHalfRange: Array(12).fill(5),
  },
];

/**
 * @param {string} id
 * @returns {Climate}
 */
export function getClimate(id) {
  const c = CLIMATES.find((x) => x.id === id);
  if (!c)
    throw new Error(`unknown climate '${id}' (known: ${CLIMATES.map((x) => x.id).join(", ")})`);
  return c;
}

/**
 * @typedef {object} City
 * @property {string} id
 * @property {string} label
 * @property {number} lat
 * @property {number} lon
 * @property {number} tz hours east of UTC (standard time)
 * @property {string} climate preset id
 */

/** Example places; coordinates are city centres, rounded. @type {City[]} */
export const CITIES = [
  {
    id: "bengaluru",
    label: "Bengaluru, India",
    lat: 12.97,
    lon: 77.59,
    tz: 5.5,
    climate: "bengaluru",
  },
  { id: "mumbai", label: "Mumbai, India", lat: 19.08, lon: 72.88, tz: 5.5, climate: "mumbai" },
  { id: "delhi", label: "New Delhi, India", lat: 28.61, lon: 77.21, tz: 5.5, climate: "delhi" },
  { id: "chennai", label: "Chennai, India", lat: 13.08, lon: 80.27, tz: 5.5, climate: "chennai" },
  {
    id: "guwahati",
    label: "Guwahati, India",
    lat: 26.14,
    lon: 91.74,
    tz: 5.5,
    climate: "guwahati",
  },
  { id: "nairobi", label: "Nairobi, Kenya", lat: -1.29, lon: 36.82, tz: 3, climate: "nairobi" },
  { id: "berlin", label: "Berlin, Germany", lat: 52.52, lon: 13.41, tz: 1, climate: "berlin" },
];

/**
 * Daily clear-sky index for each day of a 365-day year: an AR(1) Gaussian
 * process scaled by the month's standard deviation around the month's mean,
 * clamped to [0.03, 1.1], times a user scale factor.
 * @param {Climate} climate
 * @param {number} seed
 * @param {number} [scale] multiplies every day's index (1 = as fitted)
 * @param {number} [days] default 365
 * @returns {Float64Array}
 */
export function dailyClearIndex(climate, seed, scale = 1, days = 365) {
  const rng = createRng(seed);
  const phi = Math.min(0.95, Math.max(0, climate.persistence));
  const innov = Math.sqrt(1 - phi * phi);
  const out = new Float64Array(days);
  let z = rng.gaussian();
  for (let d = 0; d < days; d++) {
    if (d > 0) z = phi * z + innov * rng.gaussian();
    const m = monthOfDay(d);
    const k = climate.clearIndex[m] + climate.clearIndexStd[m] * z;
    out[d] = Math.min(1.1, Math.max(0.03, k)) * scale;
  }
  return out;
}

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

/**
 * Month (0..11) of a day index in a non-leap year (wraps every 365 days).
 * @param {number} day 0-based
 * @returns {number}
 */
export function monthOfDay(day) {
  const d = ((day % 365) + 365) % 365;
  let m = 0;
  while (d >= MONTH_START[m + 1]) m++;
  return m;
}

/**
 * Air temperature: the monthly means interpolated linearly between
 * mid-month points, plus a cosine daily cycle peaking at 15:00 local time.
 * @param {Climate} climate
 * @param {number} day 0-based day of a non-leap year
 * @param {number} hour local hour, may be fractional
 * @returns {number} degC
 */
export function airTemperature(climate, day, hour) {
  const d = ((day % 365) + 365) % 365;
  const mid = (/** @type {number} */ m) => (MONTH_START[m] + MONTH_START[m + 1]) / 2;
  let m0 = monthOfDay(d);
  if (d < mid(m0)) m0 = (m0 + 11) % 12;
  const m1 = (m0 + 1) % 12;
  const start = mid(m0);
  const span = m0 === 11 ? 365 - start + mid(0) : mid(m1) - start;
  const f = (d - start + (d < start ? 365 : 0)) / span;
  const mean = climate.tMean[m0] * (1 - f) + climate.tMean[m1] * f;
  const half = climate.tHalfRange[m0] * (1 - f) + climate.tHalfRange[m1] * f;
  return mean + half * Math.cos((2 * Math.PI * (hour - 15)) / 24);
}
