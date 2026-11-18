import { test } from "node:test";
import assert from "node:assert/strict";
import { near } from "./helpers.js";
import {
  cosIncidence,
  erbsDiffuseFraction,
  extraterrestrialNormal,
  haurwitzGhi,
  iamAshrae,
  julianDay,
  refraction,
  sunPosition,
  sunTerms,
  transpose,
  transposeComponents,
  dayOfYear,
} from "../src/core/solar.js";

// Meeus, "Astronomical Algorithms", 2nd ed., Example 25.a and 28.b:
// 1992 October 13.0 TD (JD 2448908.5). Apparent longitude 199.90988 deg,
// apparent declination -7.78507 deg, equation of time +13 min 42.6 s
// (13.7094 min). The NOAA equations are the low-precision form of these.
test("declination, longitude and equation of time match Meeus examples 25.a and 28.b", () => {
  const t = sunTerms(2448908.5);
  near(t.declination, -7.78507, 0.002, "declination");
  near(t.apparentLongitude, 199.90988, 0.002, "apparent longitude");
  near(t.eqTime, 13.7094, 0.01, "equation of time (min)");
});

// Reda and Andreas, "Solar Position Algorithm for Solar Radiation
// Applications", NREL/TP-560-34302 (revised 2008), worked example:
// 2003-10-17 12:30:30 local time, UTC-7, 39.742476 N, 105.1786 W:
// topocentric zenith 50.11162 deg, azimuth 194.34024 deg. The NOAA
// equations are quoted at about 0.01-0.03 deg; we allow 0.05 deg.
test("zenith and azimuth agree with the NREL SPA reference case", () => {
  const ms = Date.UTC(2003, 9, 17, 19, 30, 30);
  const p = sunPosition(ms, 39.742476, -105.1786, true);
  near(p.zenith, 50.11162, 0.05, "zenith");
  near(p.azimuth, 194.34024, 0.05, "azimuth");
});

test("julian day of the Unix epoch and J2000", () => {
  assert.equal(julianDay(0), 2440587.5);
  assert.equal(julianDay(Date.UTC(2000, 0, 1, 12)), 2451545);
});

test("sun is overhead-ish at local solar noon on the equator at an equinox and down at midnight", () => {
  // 2025-03-20 near the equinox; longitude 0 so solar noon is near 12:00 UTC (+ equation of time).
  const noon = sunPosition(Date.UTC(2025, 2, 20, 12, 7), 0, 0);
  assert.ok(noon.zenith < 1.5, `zenith ${noon.zenith}`);
  const midnight = sunPosition(Date.UTC(2025, 2, 20, 0, 7), 0, 0);
  assert.ok(midnight.zenith > 178, `zenith ${midnight.zenith}`);
});

test("morning sun is in the east and afternoon sun in the west (northern mid-latitude)", () => {
  const am = sunPosition(Date.UTC(2025, 5, 21, 3, 0), 28.6, 77.2); // 08:30 IST
  const pm = sunPosition(Date.UTC(2025, 5, 21, 11, 0), 28.6, 77.2); // 16:30 IST
  assert.ok(am.azimuth > 45 && am.azimuth < 135, `am ${am.azimuth}`);
  assert.ok(pm.azimuth > 225 && pm.azimuth < 315, `pm ${pm.azimuth}`);
  assert.ok(am.hourAngle < 0 && pm.hourAngle > 0);
});

test("pole and zenith edge cases give a defined azimuth", () => {
  const p = sunPosition(Date.UTC(2025, 5, 21, 12), 90, 0);
  assert.ok(Number.isFinite(p.azimuth));
  near(p.zenith, 90 - 23.44, 0.1, "zenith at the pole near the June solstice");
});

test("refraction is about 34 arcmin at the horizon, zero overhead and small at 45 deg", () => {
  near(refraction(0), 1735 / 3600, 1e-12, "horizon");
  assert.equal(refraction(89), 0);
  near(refraction(45) * 60, 0.97, 0.05, "45 deg (arcmin)");
  assert.ok(refraction(-2) > 0);
});

test("extraterrestrial irradiance peaks in early January", () => {
  near(extraterrestrialNormal(0), 1367 * 1.033, 1e-9, "perihelion");
  assert.ok(extraterrestrialNormal(182) < extraterrestrialNormal(1));
});

test("Haurwitz clear sky: zero below the horizon, 1035 W/m^2 overhead, falls with zenith", () => {
  assert.equal(haurwitzGhi(90), 0);
  assert.equal(haurwitzGhi(120), 0);
  near(haurwitzGhi(0), 1098 * Math.exp(-0.059), 1e-9, "overhead");
  assert.ok(haurwitzGhi(30) > haurwitzGhi(60));
  assert.ok(haurwitzGhi(60) > 400 && haurwitzGhi(60) < 600, `${haurwitzGhi(60)}`);
});

test("Erbs diffuse fraction: piecewise values and continuity", () => {
  near(erbsDiffuseFraction(0), 1, 1e-12, "kt 0");
  near(erbsDiffuseFraction(0.9), 0.165, 1e-12, "kt 0.9");
  near(erbsDiffuseFraction(0.22), 1 - 0.09 * 0.22, 1e-12, "kt 0.22");
  near(erbsDiffuseFraction(0.2201), erbsDiffuseFraction(0.22), 0.01, "continuity at 0.22");
  near(erbsDiffuseFraction(0.8001), erbsDiffuseFraction(0.8), 0.01, "continuity at 0.8");
  assert.ok(erbsDiffuseFraction(0.7) < erbsDiffuseFraction(0.4));
});

test("incidence angle: panel facing the sun sees the beam head-on", () => {
  near(cosIncidence(30, 180, 30, 180), 1, 1e-12, "facing the sun");
  near(cosIncidence(30, 180, 0, 180), Math.cos((30 * Math.PI) / 180), 1e-12, "horizontal panel");
  assert.ok(cosIncidence(30, 0, 90, 180) < 0, "sun behind a vertical south-facing panel");
  assert.equal(iamAshrae(1), 1);
  assert.equal(iamAshrae(-0.1), 0);
  assert.equal(iamAshrae(0.01), 0);
  near(iamAshrae(0.5), 0.95, 1e-12, "60 deg incidence");
});

test("horizontal panel: plane-of-array irradiance is beam x cos z x IAM + diffuse", () => {
  const r = transposeComponents(600, 700, 150, 40, 120, { tilt: 0, azimuth: 180, albedo: 0.2 });
  const cz = Math.cos((40 * Math.PI) / 180);
  near(r.poa, 700 * cz * iamAshrae(cz) + 150, 1e-9, "poa");
  assert.equal(r.ground, 0);
});

test("transposition splits global into beam and diffuse that add back up", () => {
  const r = transpose(800, 30, 180, 172, { tilt: 0, azimuth: 180, albedo: 0.2 });
  const cz = Math.cos((30 * Math.PI) / 180);
  near(r.dni * cz + r.dhi, 800, 1e-9, "closure");
  assert.ok(r.dhi > 0 && r.dhi < 800);
  const tilted = transpose(800, 50, 180, 172, { tilt: 30, azimuth: 180 });
  const flat = transpose(800, 50, 180, 172, { tilt: 0, azimuth: 180 });
  assert.ok(tilted.poa > flat.poa, "tilting towards a low sun helps");
  const back = transpose(800, 50, 180, 172, { tilt: 60, azimuth: 0 });
  assert.equal(back.beam, 0);
  assert.ok(back.poa > 0, "a panel facing away still gets diffuse light");
});

test("transposition at night or with the sun on the horizon is diffuse only", () => {
  const night = transpose(0, 100, 0, 1, { tilt: 20, azimuth: 180 });
  assert.equal(night.poa, 0);
  const dusk = transpose(5, 89.8, 270, 1, { tilt: 20, azimuth: 180 });
  assert.equal(dusk.beam, 0);
  assert.ok(dusk.poa > 0 && dusk.poa <= 5.01);
});

test("day of year with a time zone", () => {
  assert.equal(dayOfYear(Date.UTC(2025, 0, 1, 0)), 1);
  assert.equal(dayOfYear(Date.UTC(2024, 11, 31, 20), 5.5), 1);
  assert.equal(dayOfYear(Date.UTC(2025, 11, 31, 12)), 365);
});
