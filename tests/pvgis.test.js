// The fixtures in tests/fixtures/ are hand-written files in the layout of
// PVGIS 5.3 CSV downloads (metadata lines, header, rows, legend, copyright
// line). Their numbers were typed for the tests and are NOT PVGIS output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PvgisFormatError, parsePvgisCsv, parsePvgisTime } from "../src/core/pvgis.js";

const series = readFileSync(new URL("fixtures/pvgis-series-sample.csv", import.meta.url), "utf8");
const tmy = readFileSync(new URL("fixtures/pvgis-tmy-sample.csv", import.meta.url), "utf8");

test("time stamps are UTC YYYYMMDD:HHMM", () => {
  assert.equal(parsePvgisTime("20200601:0130"), Date.UTC(2020, 5, 1, 1, 30));
  assert.ok(Number.isNaN(parsePvgisTime("2020-06-01 01:30")));
  assert.ok(Number.isNaN(parsePvgisTime("20201301:0000")));
  assert.ok(Number.isNaN(parsePvgisTime("20200601:2500")));
});

test("hourly series: metadata, azimuth conversion and values", () => {
  const d = parsePvgisCsv(series);
  assert.equal(d.kind, "series");
  assert.equal(d.meta.lat, 12.972);
  assert.equal(d.meta.lon, 77.594);
  assert.equal(d.meta.elevation, 914);
  assert.equal(d.meta.database, "PVGIS-ERA5");
  assert.equal(d.meta.slope, 15);
  assert.equal(d.meta.azimuth, 150, "PVGIS -30 (east of south) is 150 clockwise from north");
  assert.equal(d.times.length, 48, "legend and copyright lines are not data");
  assert.equal(d.times[0], Date.UTC(2020, 5, 1, 0, 30));
  const poa = /** @type {Float64Array} */ (d.poa);
  assert.equal(poa[1], 12.5);
  assert.equal(poa[6], 700);
  assert.equal(poa[24 + 6], 280);
  assert.equal(d.tAmb[0], 18.83);
  assert.deepEqual(d.warnings, []);
});

test("Windows line endings and a byte-order mark are accepted", () => {
  const d = parsePvgisCsv("﻿" + series.replace(/\n/g, "\r\n"));
  assert.equal(d.times.length, 48);
  assert.equal(d.meta.lat, 12.972);
  assert.equal(/** @type {Float64Array} */ (d.poa)[6], 700);
});

test("series with components: beam + diffuse + reflected are summed", () => {
  const text = [
    "Latitude (decimal degrees):\t12.972",
    "Slope: 15 deg. ",
    "Azimuth: 0 deg. ",
    "Nominal power of the PV system (c-Si) (kWp):\t1.0",
    "time,P,Gb(i),Gd(i),Gr(i),H_sun,T2m,WS10m,Int",
    ...Array.from(
      { length: 24 },
      (_, h) => `20200101:${String(h).padStart(2, "0")}30,1,${h},2,0.5,10,20,1,0.0`,
    ),
    "",
    "P: PV system power (W)",
  ].join("\n");
  const d = parsePvgisCsv(text);
  assert.equal(d.meta.azimuth, 180);
  assert.equal(/** @type {Float64Array} */ (d.poa)[10], 12.5);
});

test("TMY: horizontal components, time offset, re-timed as one year", () => {
  const d = parsePvgisCsv(tmy);
  assert.equal(d.kind, "tmy");
  assert.equal(d.meta.timeOffsetH, 0.5);
  assert.equal(d.meta.slope, null);
  assert.equal(d.times.length, 48);
  // The second day comes from February 2018 in the file; it is re-timed to follow on.
  assert.equal(d.times[24] - d.times[23], 3600000);
  assert.equal(d.times[0], Date.UTC(2025, 0, 1, 0, 0));
  assert.equal(/** @type {Float64Array} */ (d.ghi)[5], 720);
  assert.equal(/** @type {Float64Array} */ (d.dhi)[5], 144);
  assert.ok(d.warnings.some((w) => /8760 expected/.test(w)));
});

test("missing temperature, unreadable values and a missing slope give warnings, not errors", () => {
  const rows = Array.from(
    { length: 24 },
    (_, h) => `20200101:${String(h).padStart(2, "0")}10,${h === 5 ? "x" : 100}`,
  );
  const d = parsePvgisCsv(["time,G(i)", ...rows].join("\n"));
  assert.equal(d.tAmb[0], 25);
  assert.equal(/** @type {Float64Array} */ (d.poa)[5], 0);
  assert.ok(d.warnings.some((w) => /No T2m/.test(w)));
  assert.ok(d.warnings.some((w) => /unreadable/.test(w)));
  assert.ok(d.warnings.some((w) => /Slope/.test(w)));
  assert.ok(d.warnings.some((w) => /Azimuth/.test(w)));
});

test("negative irradiance is clipped to zero", () => {
  const rows = Array.from(
    { length: 24 },
    (_, h) => `20200101:${String(h).padStart(2, "0")}10,-1,0,20,1,0`,
  );
  const d = parsePvgisCsv(["time,G(i),H_sun,T2m,WS10m,Int", ...rows].join("\n"));
  assert.equal(/** @type {Float64Array} */ (d.poa)[0], 0);
});

test("clear errors for files that are not PVGIS hourly CSVs", () => {
  assert.throws(() => parsePvgisCsv("hello,world\n1,2\n"), PvgisFormatError);
  assert.throws(() => parsePvgisCsv("time,A,B\n20200101:0000,1,2\n"), /Unrecognised columns/);
  assert.throws(() => parsePvgisCsv("time,G(i)\n20200101:0000,1\n"), /need at least one day/);
  const gap = Array.from(
    { length: 30 },
    (_, h) => `202001${h < 15 ? "01" : "02"}:${String(h % 24).padStart(2, "0")}00,1`,
  );
  assert.throws(() => parsePvgisCsv(["time,G(i)", ...gap].join("\n")), /consecutive hours/);
});

test("junk between the header and the first row is skipped with a warning", () => {
  const rows = Array.from(
    { length: 24 },
    (_, h) => `20200101:${String(h).padStart(2, "0")}10,5,1,20,1,0`,
  );
  const d = parsePvgisCsv(
    ["time,G(i),H_sun,T2m,WS10m,Int", "units,W/m2,deg,C,m/s,-", ...rows].join("\n"),
  );
  assert.equal(d.times.length, 24);
  assert.ok(d.warnings.some((w) => /skipped/.test(w)));
});
