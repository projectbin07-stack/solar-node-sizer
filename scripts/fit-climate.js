// Derive the parameters of a synthetic climate preset from a PVGIS hourly
// series on a HORIZONTAL plane (download with slope 0) that you saved
// yourself. Used to set the built-in presets in src/core/weather.js; the
// downloaded files are not part of this repository.
//
//   node scripts/fit-climate.js Bengaluru_2020_horizontal.csv --tz 5.5
//
// Prints, per month: the clear-sky index (sum of measured GHI over sum of
// Haurwitz clear-sky GHI), the standard deviation of the daily index, mean
// air temperature and mean half diurnal range, plus the lag-1
// autocorrelation of the daily index anomalies over the whole file.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePvgisCsv } from "../src/core/pvgis.js";
import { haurwitzGhi, sunPosition } from "../src/core/solar.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tz: { type: "string", default: "0" } },
});
if (positionals.length !== 1) {
  console.error("usage: node scripts/fit-climate.js <pvgis-horizontal.csv> [--tz hours]");
  process.exit(2);
}
const tz = Number(values.tz);
const data = parsePvgisCsv(readFileSync(positionals[0], "utf8"));
if (data.kind !== "series" || !data.poa) throw new Error("need a PVGIS hourly series");
if (data.meta.slope !== 0) console.error(`warning: slope is ${data.meta.slope}, not 0`);
const lat = /** @type {number} */ (data.meta.lat);
const lon = /** @type {number} */ (data.meta.lon);

/** @type {Map<string, {month: number, ghi: number, clear: number, tmin: number, tmax: number, tsum: number, n: number}>} */
const days = new Map();
for (let i = 0; i < data.times.length; i++) {
  const t = data.times[i];
  let clear = 0;
  for (let k = 0; k < 4; k++) {
    const s = sunPosition(t + (k * 15 - 22.5) * 60000, lat, lon);
    clear += haurwitzGhi(s.zenith) / 4;
  }
  const local = new Date(t + tz * 3600000);
  const key = local.toISOString().slice(0, 10);
  let d = days.get(key);
  if (!d) {
    d = {
      month: local.getUTCMonth(),
      ghi: 0,
      clear: 0,
      tmin: Infinity,
      tmax: -Infinity,
      tsum: 0,
      n: 0,
    };
    days.set(key, d);
  }
  d.ghi += data.poa[i];
  d.clear += clear;
  d.tmin = Math.min(d.tmin, data.tAmb[i]);
  d.tmax = Math.max(d.tmax, data.tAmb[i]);
  d.tsum += data.tAmb[i];
  d.n++;
}
const list = [...days.values()].filter((d) => d.n === 24 && d.clear > 0);
const r2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;
const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
/** @type {number[]} */ const kMean = [];
/** @type {number[]} */ const kStd = [];
/** @type {number[]} */ const tMean = [];
/** @type {number[]} */ const tHalf = [];
for (let m = 0; m < 12; m++) {
  const ds = list.filter((d) => d.month === m);
  const mean = ds.reduce((a, d) => a + d.ghi, 0) / ds.reduce((a, d) => a + d.clear, 0);
  const ks = ds.map((d) => d.ghi / d.clear);
  const avg = ks.reduce((a, b) => a + b, 0) / ks.length;
  const std = Math.sqrt(ks.reduce((a, b) => a + (b - avg) ** 2, 0) / (ks.length - 1));
  kMean.push(r2(mean));
  kStd.push(r2(std));
  tMean.push(r1(ds.reduce((a, d) => a + d.tsum / d.n, 0) / ds.length));
  tHalf.push(r1(ds.reduce((a, d) => a + (d.tmax - d.tmin) / 2, 0) / ds.length));
}
const anomalies = list.map(
  (d) => (d.ghi / d.clear - kMean[d.month]) / Math.max(0.01, kStd[d.month]),
);
let num = 0;
let den = 0;
for (let i = 0; i < anomalies.length; i++) {
  den += anomalies[i] ** 2;
  if (i > 0) num += anomalies[i] * anomalies[i - 1];
}
console.log(
  JSON.stringify(
    {
      source: `${data.meta.database}, ${new Date(data.times[0]).getUTCFullYear()}`,
      lat,
      lon,
      elevation: data.meta.elevation,
      days: list.length,
      clearIndex: kMean,
      clearIndexStd: kStd,
      persistence: r2(num / den),
      tMean,
      tHalfRange: tHalf,
    },
    null,
    0,
  ),
);
