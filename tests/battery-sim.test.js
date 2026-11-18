import { test } from "node:test";
import assert from "node:assert/strict";
import { near } from "./helpers.js";
import {
  CHEMISTRIES,
  coldFactor,
  getChemistry,
  interp,
  ocv,
  selfDischargePerHour,
  socAtVoltage,
} from "../src/core/battery.js";
import { cellTemperature, chargerOutput, powerPerWp } from "../src/core/pv.js";
import { normalizeConfig } from "../src/core/config.js";
import { prepare, simulate, chargeHour, worstDeficit } from "../src/core/simulate.js";

/** @typedef {import("../src/core/resource.js").Resource} Resource */

/**
 * A hand-made resource: constant sunshine pattern every day.
 * @param {number} days
 * @param {(day: number, hour: number) => number} poa
 * @param {number} [temp]
 * @returns {Resource}
 */
function flatResource(days, poa, temp = 25) {
  const hours = days * 24;
  const p = new Float64Array(hours);
  const t = new Float64Array(hours).fill(temp);
  for (let h = 0; h < hours; h++) p[h] = poa(Math.floor(h / 24), h % 24);
  return {
    kind: "synthetic",
    label: "test",
    startMs: Date.UTC(2025, 0, 1),
    hours,
    poa: p,
    tAmb: t,
    tilt: 0,
    azimuth: 180,
    notes: [],
  };
}

const sunny = (/** @type {number} */ _d, /** @type {number} */ h) =>
  h >= 7 && h < 17 ? 800 * Math.sin((Math.PI * (h + 0.5 - 7)) / 10) : 0;

test("OCV table and its inverse round-trip", () => {
  for (const chem of CHEMISTRIES) {
    for (const s of [0.05, 0.2, 0.5, 0.85, 1])
      near(socAtVoltage(chem, 2, ocv(chem, 2, s)), s, 1e-9, chem.id);
  }
  const li = getChemistry("liion");
  assert.equal(ocv(li, 1, 1), 4.18);
  assert.equal(ocv(li, 1, -1), 3.0);
  assert.equal(socAtVoltage(li, 1, 5), 1);
  assert.equal(interp([[0, 1]], 3), 1);
  assert.throws(() => getChemistry("lead-acid"), /unknown chemistry/);
});

test("cold derating, self-discharge compounding", () => {
  const li = getChemistry("liion");
  assert.equal(coldFactor(li, 25), 1);
  near(coldFactor(li, 0), 1 - 0.008 * 20, 1e-12, "0 degC");
  assert.equal(coldFactor(li, -200), 0.3);
  const perHour = selfDischargePerHour(0.03);
  near(1 - (1 - perHour) ** 730, 0.03, 1e-12, "730 h compound to the monthly figure");
  assert.equal(selfDischargePerHour(0), 0);
});

test("panel model: NOCT temperature and derating", () => {
  near(cellTemperature(20, 800, 45), 45, 1e-12, "NOCT definition");
  const p = {
    wp: 1,
    tilt: 0,
    azimuth: 180,
    albedo: 0.2,
    tempCoeff: -0.004,
    noct: 45,
    soiling: 0.05,
    otherLosses: 0.1,
    vmp: 6,
  };
  // 1000 W/m^2 at 25 degC air: Tc = 56.25, power = 1 x (1 - 0.004 x 31.25) x 0.95 x 0.9.
  near(powerPerWp(1000, 25, p), (1 - 0.004 * 31.25) * 0.95 * 0.9, 1e-12, "hot panel");
  assert.equal(powerPerWp(0, 25, p), 0);
});

test("charger models: MPPT keeps power, linear keeps current, both obey the limit", () => {
  const mppt = { type: /** @type {const} */ ("mppt"), efficiency: 0.9, maxCurrentMa: 1000 };
  const lin = { type: /** @type {const} */ ("linear"), efficiency: 1, maxCurrentMa: 1000 };
  near(chargerOutput(1, 3.7, mppt, 6), 0.9, 1e-12, "MPPT");
  // 1 W at Vmp 6 V is 166.7 mA; at 3.7 V that is 0.617 W.
  near(chargerOutput(1, 3.7, lin, 6), (1 / 6) * 3.7, 1e-12, "linear");
  near(chargerOutput(10, 3.7, { ...lin, maxCurrentMa: 500 }, 6), 0.5 * 3.7, 1e-12, "current limit");
  near(
    chargerOutput(10, 3.7, { ...mppt, maxCurrentMa: 500 }, 6),
    0.5 * 3.7,
    1e-12,
    "current limit",
  );
  assert.equal(chargerOutput(0, 3.7, mppt, 6), 0);
});

test("chargeHour: constant-power phase is exact, taper slows it, never past full", () => {
  // 1 W into 10 Wh at 90 %: 0.9 Wh in an hour, well below the taper.
  near(chargeHour(0.2, 1, 5, 0.9, 10, 0.8), 0.9, 1e-12, "constant phase");
  const nearFull = chargeHour(0.95, 5, 5, 1, 10, 0.8);
  assert.ok(nearFull > 0 && nearFull <= 0.5 + 1e-12, `${nearFull}`);
  assert.equal(chargeHour(1, 5, 5, 1, 10, 0.8), 0);
  assert.equal(chargeHour(0.5, 0, 5, 1, 10, 0.8), 0);
  // Monotonic: starting fuller never ends emptier.
  let prevEnd = -1;
  for (let s = 0; s <= 1; s += 0.01) {
    const end = s + chargeHour(s, 3, 5, 0.95, 10, 0.8) / 10;
    assert.ok(end >= prevEnd - 1e-12, `end ${end} after ${prevEnd} at soc ${s}`);
    assert.ok(end <= 1 + 1e-12);
    prevEnd = end;
  }
  // A full hour at a limited offer that crosses into the taper region.
  const crossing = chargeHour(0.75, 1, 5, 1, 2, 0.8);
  assert.ok(crossing < 1 && crossing > 0.4, `${crossing}`);
});

test("worst deficit: largest cumulative shortfall over consecutive days", () => {
  const harvest = [5, 5, 1, 0, 2, 5, 0, 0, 0, 9];
  // load 3/day: run from day 2: +2, +5, +6, then day 5 -> 4, day 6..8 -> 7, 10, 13, day 9 -> 7
  const d = worstDeficit(harvest, 3);
  assert.equal(d.wh, 13);
  assert.equal(d.startDay, 2);
  assert.equal(d.days, 7);
  assert.deepEqual(worstDeficit([5, 5], 3), { wh: 0, startDay: 0, days: 0 });
});

test("energy balance: stored - delivered - self-discharge = change in stored energy", () => {
  for (const [wp, mah, climate] of /** @type {Array<[number, number, string]>} */ ([
    [1, 2500, "bengaluru"],
    [0.03, 150, "mumbai"],
    [0.02, 500, "berlin"],
  ])) {
    const c = normalizeConfig({
      panel: { wp },
      battery: { capacityMah: mah },
      location: { climate },
    });
    const res = flatResource(365, (d, h) => sunny(d, h) * (d % 9 === 0 ? 0.1 : 1));
    const r = simulate(c, prepare(c, res));
    const t = r.totals;
    near(t.stored - t.load - t.selfDischarge, r.eEndWh - r.eStartWh, 1e-9, `balance ${wp} Wp`);
    near(t.accepted * getChemistry("liion").chargeEff, t.stored, 1e-9, "charge efficiency");
    near(t.offered - t.accepted, t.clipped, 1e-9, "clipping");
    const monthLoad = r.months.reduce((a, m) => a + m.loadWh, 0);
    near(monthLoad, t.load, 1e-9, "monthly load sums to the total");
    const monthHarvest = r.months.reduce((a, m) => a + m.harvestWh, 0);
    near(monthHarvest, t.stored, 1e-9, "monthly harvest sums to the total");
  }
});

test("state of charge stays within [0, 1] and above the floor while the node runs", () => {
  const c = normalizeConfig({ panel: { wp: 0.02 }, battery: { capacityMah: 300 } });
  const res = flatResource(120, (d, h) => sunny(d, h) * (d > 30 && d < 60 ? 0.05 : 1));
  const r = simulate(c, prepare(c, res));
  for (let h = 0; h < r.hours; h++) {
    assert.ok(r.soc[h] >= 0 && r.soc[h] <= 1 + 1e-9, `soc ${r.soc[h]} at ${h}`);
    if (r.down[h] === 0)
      assert.ok(r.soc[h] >= r.limits.socMin - 1e-6, `below floor while up at ${h}`);
  }
  assert.ok(r.downtimeHours > 0, "the dark month causes downtime");
  assert.ok(r.downtimeEvents >= 1);
  assert.ok(r.longestOutageHours > 0 && r.longestOutageHours <= r.downtimeHours);
  assert.ok(r.worstWeekStartDay >= 30 && r.worstWeekStartDay <= 60, `${r.worstWeekStartDay}`);
});

test("no panel: the node runs down the battery then stays down; autonomy matches", () => {
  const c = normalizeConfig({
    panel: { wp: 0 },
    battery: { capacityMah: 100, selfDischargePerMonth: 0 },
    simulation: { warmupYears: 0, restartFraction: 0.05 },
  });
  const res = flatResource(60, () => 0);
  const r = simulate(c, prepare(c, res));
  // Usable 0.296 Wh; the load is ~0.0565 Wh/day, so about 5.2 days up.
  const upDays = (r.hours - r.downtimeHours) / 24;
  // Autonomy uses the nominal 3.7 V; the simulation uses the open-circuit
  // voltage, which is higher for most of the discharge, and an LDO draws the
  // same current at any input voltage, so the run is a few percent shorter.
  assert.ok(
    upDays < r.autonomyDays && upDays > 0.95 * r.autonomyDays,
    `${upDays} vs ${r.autonomyDays}`,
  );
  assert.equal(r.downtimeEvents, 1);
  near(r.minSoc, r.limits.socMin, 1e-6, "ends at the floor");
});

test("cold weather locks part of the battery and stops charging below 0 degC", () => {
  const c = normalizeConfig({
    panel: { wp: 1 },
    battery: { capacityMah: 500, initialSoc: 0.5 },
    simulation: { warmupYears: 0, restartFraction: 0 },
  });
  const warm = simulate(c, prepare(c, flatResource(10, sunny, 20)));
  const frozen = simulate(c, prepare(c, flatResource(10, sunny, -5)));
  assert.ok(warm.totals.accepted > 0);
  assert.equal(frozen.totals.accepted, 0, "no charging below 0 degC");
  assert.ok(frozen.downtimeHours > warm.downtimeHours);
});

test("simulation is deterministic and the warm-up year changes only the start", () => {
  const c = normalizeConfig({ panel: { wp: 0.03 }, battery: { capacityMah: 100 } });
  const res = flatResource(365, (d, h) => sunny(d, h) * (0.3 + (0.7 * ((d * 7919) % 13)) / 13));
  const a = simulate(c, prepare(c, res));
  const b = simulate(c, prepare(c, res));
  assert.deepEqual(a.soc, b.soc);
  assert.equal(a.downtimeHours, b.downtimeHours);
  const noRecord = simulate(c, prepare(c, res), { record: false });
  assert.equal(noRecord.soc.length, 0);
  assert.equal(noRecord.downtimeHours, a.downtimeHours);
});
