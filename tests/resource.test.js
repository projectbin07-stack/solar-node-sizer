import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { near } from "./helpers.js";
import { pvgisResource, syntheticResource } from "../src/core/resource.js";
import { parsePvgisCsv } from "../src/core/pvgis.js";
import {
  CITIES,
  CLIMATES,
  airTemperature,
  dailyClearIndex,
  getClimate,
  monthOfDay,
} from "../src/core/weather.js";

const BLR = {
  lat: 12.97,
  lon: 77.59,
  tz: 5.5,
  tilt: 15,
  azimuth: 180,
  albedo: 0.2,
  climate: "bengaluru",
  seed: 1,
  cloudScale: 1,
};

test("synthetic year: 8760 hours, zero at night, peak near solar noon", () => {
  const r = syntheticResource({ ...BLR, climate: "clear" });
  assert.equal(r.hours, 8760);
  assert.equal(r.kind, "synthetic");
  for (let d = 0; d < 365; d += 30) {
    const day = Array.from(r.poa.slice(d * 24, d * 24 + 24));
    assert.equal(day[0], 0, `midnight on day ${d}`);
    assert.equal(day[2], 0, `02:00 on day ${d}`);
    assert.equal(day[22], 0, `22:00 on day ${d}`);
    // Bengaluru solar noon is about 12:20 IST (77.59 E vs the 82.5 E meridian),
    // so the brightest hour is 11:00-12:00 or 12:00-13:00.
    const peak = day.indexOf(Math.max(...day));
    assert.ok(peak === 11 || peak === 12, `peak hour ${peak} on day ${d}`);
  }
});

test("clear-sky magnitude: daily plane-of-array energy is plausible for 13 N", () => {
  const r = syntheticResource({ ...BLR, climate: "clear" });
  let annual = 0;
  for (const v of r.poa) annual += v;
  annual /= 1000; // kWh/m^2
  // Clear every day at index 0.95: well above real sites (about 1900-2100
  // kWh/m^2 for Bengaluru from PVGIS), below the extraterrestrial ~3300.
  assert.ok(annual > 2200 && annual < 2900, `annual ${annual}`);
  const noon = r.poa[24 * 100 + 12];
  assert.ok(noon > 800 && noon < 1100, `noon ${noon}`);
});

test("synthetic weather is deterministic for a seed and differs between seeds", () => {
  const a = syntheticResource(BLR);
  const b = syntheticResource(BLR);
  const c = syntheticResource({ ...BLR, seed: 2 });
  assert.deepEqual(a.poa, b.poa);
  assert.deepEqual(a.tAmb, b.tAmb);
  assert.notDeepEqual(a.poa, c.poa);
  assert.match(a.notes[0], /illustrative/);
});

test("monsoon months receive less light than the dry season in the Mumbai-like preset", () => {
  const r = syntheticResource({ ...BLR, lat: 19.08, lon: 72.88, climate: "mumbai" });
  const month = (/** @type {number} */ m) => {
    let s = 0;
    for (let h = 0; h < r.hours; h++)
      if (new Date(r.startMs + h * 3600000).getUTCMonth() === m) s += r.poa[h];
    return s;
  };
  assert.ok(month(7) < 0.6 * month(2), "August vs March");
});

test("cloud scale reduces the light proportionally", () => {
  const a = syntheticResource(BLR);
  const half = syntheticResource({ ...BLR, cloudScale: 0.5 });
  const sum = (/** @type {Float64Array} */ x) => x.reduce((p, v) => p + v, 0);
  const ratio = sum(half.poa) / sum(a.poa);
  // Not exactly 0.5: the diffuse share rises as the sky gets darker.
  assert.ok(ratio > 0.4 && ratio < 0.6, `ratio ${ratio}`);
  assert.match(half.label, /clouds x0.5/);
});

test("daily clear-sky index: bounded, seeded, and centred on the monthly means", () => {
  const climate = getClimate("bengaluru");
  const k = dailyClearIndex(climate, 7);
  assert.equal(k.length, 365);
  for (const v of k) assert.ok(v >= 0.03 && v <= 1.1);
  assert.deepEqual(k, dailyClearIndex(climate, 7));
  // Average over many seeds is close to the January mean (0.94, std 0.13; clamping at 1.1 trims a little).
  let s = 0;
  let n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const kk = dailyClearIndex(climate, seed);
    for (let d = 0; d < 31; d++) {
      s += kk[d];
      n++;
    }
  }
  near(s / n, 0.94, 0.04, "January mean");
  const clear = dailyClearIndex(getClimate("clear"), 3, 0.5);
  for (const v of clear) near(v, 0.475, 1e-12, "no variance");
});

test("month of day and air temperature cycle", () => {
  assert.equal(monthOfDay(0), 0);
  assert.equal(monthOfDay(31), 1);
  assert.equal(monthOfDay(364), 11);
  assert.equal(monthOfDay(365), 0);
  assert.equal(monthOfDay(-1), 11);
  const c = getClimate("delhi");
  // Mid-January (day 15.5 is the January mid-point): the monthly mean +- half range.
  near(airTemperature(c, 15.5, 15), c.tMean[0] + c.tHalfRange[0], 1e-9, "15:00");
  near(airTemperature(c, 15.5, 3), c.tMean[0] - c.tHalfRange[0], 1e-9, "03:00");
  // Year wrap: 31 Dec (day 364) and 1 Jan (day 0) interpolate between December and January.
  const dec31 = airTemperature(c, 364, 9);
  const jan1 = airTemperature(c, 0, 9);
  assert.ok(Math.abs(dec31 - jan1) < 0.2, `${dec31} vs ${jan1}`);
});

test("presets are complete and every example city has a climate", () => {
  for (const c of CLIMATES) {
    for (const key of /** @type {const} */ (["clearIndex", "clearIndexStd", "tMean", "tHalfRange"]))
      assert.equal(c[key].length, 12, `${c.id}.${key}`);
    assert.ok(c.source.length > 0);
  }
  for (const city of CITIES) assert.doesNotThrow(() => getClimate(city.climate));
  assert.throws(() => getClimate("atlantis"), /unknown climate/);
});

test("PVGIS series: rotated into local time with the file's tilt and azimuth", () => {
  const data = parsePvgisCsv(
    readFileSync(new URL("fixtures/pvgis-series-sample.csv", import.meta.url), "utf8"),
  );
  const r = pvgisResource(data, { tz: 5.5, tilt: 40, azimuth: 90, albedo: 0.2 });
  assert.equal(r.kind, "pvgis-series");
  assert.equal(r.hours, 48);
  assert.equal(r.tilt, 15);
  assert.equal(r.azimuth, 150);
  // 5.5 h rounds to 6: UTC row 1 (01:30, 12.5 W/m^2) lands in local hour 7.
  assert.equal(r.poa[7], 12.5);
  assert.equal(r.poa[6], 0);
  assert.ok(r.notes.some((n) => /rounded to 6 h/.test(n)));
  assert.match(r.label, /PVGIS hourly data at 12.972, 77.594 \(PVGIS-ERA5, 2020-2020\)/);
});

test("PVGIS TMY: transposed with the settings' tilt; a flat panel gets about the global value", () => {
  const data = parsePvgisCsv(
    readFileSync(new URL("fixtures/pvgis-tmy-sample.csv", import.meta.url), "utf8"),
  );
  const flat = pvgisResource(data, { tz: 0, tilt: 0, azimuth: 180, albedo: 0.2 });
  assert.equal(flat.kind, "pvgis-tmy");
  assert.equal(flat.tilt, 0);
  let g = 0;
  let p = 0;
  for (let h = 0; h < 48; h++) {
    g += /** @type {Float64Array} */ (data.ghi)[h];
    p += flat.poa[h];
  }
  // Not exact: the sample's components are hand-made, not a consistent split.
  assert.ok(p > 0.6 * g && p < 1.4 * g, `poa ${p} vs ghi ${g}`);
  const tilted = pvgisResource(data, { tz: 5.5, tilt: 30, azimuth: 180, albedo: 0.2 });
  assert.equal(tilted.tilt, 30);
  assert.ok(tilted.notes.some((n) => /different years/.test(n)));
});
