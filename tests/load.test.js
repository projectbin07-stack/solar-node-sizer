import { test } from "node:test";
import assert from "node:assert/strict";
import { near } from "./helpers.js";
import {
  REGULATOR_PRESETS,
  activeInHour,
  batteryPower,
  dailyBudget,
  dutyFraction,
  efficiencyAt,
  hourLoads,
  hourlyShares,
  peakBatteryMa,
  regulatorMinVin,
} from "../src/core/load.js";

/** @typedef {import("../src/core/load.js").LoadState} LoadState */

/** @type {LoadState[]} */
const ESP32 = [
  { name: "sleep", mA: 0.015, base: true },
  { name: "read", mA: 40, every: 600, duration: 0.3 },
  { name: "wifi", mA: 120, every: 600, duration: 3 },
];
const LDO = REGULATOR_PRESETS["ldo-lowiq"].regulator;
const BUCK = REGULATOR_PRESETS.buck.regulator;
const NONE = REGULATOR_PRESETS.none.regulator;

test("duty fraction and active hours, including windows that wrap midnight", () => {
  assert.equal(dutyFraction({ name: "x", mA: 1, every: 600, duration: 3 }), 0.005);
  assert.equal(dutyFraction({ name: "x", mA: 1, every: 1, duration: 5 }), 1);
  assert.equal(dutyFraction({ name: "x", mA: 1, base: true }), 0);
  assert.equal(dutyFraction({ name: "x", mA: 1, every: 0, duration: 5 }), 0);
  const day = { name: "d", mA: 1, every: 60, duration: 1, from: 6, to: 18 };
  assert.ok(activeInHour(day, 6) && activeInHour(day, 17));
  assert.ok(!activeInHour(day, 18) && !activeInHour(day, 5));
  const night = { name: "n", mA: 1, every: 60, duration: 1, from: 22, to: 2 };
  assert.ok(activeInHour(night, 23) && activeInHour(night, 1));
  assert.ok(!activeInHour(night, 2) && !activeInHour(night, 12));
  assert.ok(activeInHour({ name: "a", mA: 1, from: 5, to: 5 }, 3), "equal bounds mean all day");
});

test("hourly shares: the base state fills the remainder; overbooked hours are scaled", () => {
  const { shares, overbooked } = hourlyShares(ESP32);
  assert.equal(shares.length, 24);
  near(shares[0][0], 1 - 0.0005 - 0.005, 1e-15, "sleep share");
  near(
    shares[0].reduce((a, b) => a + b, 0),
    1,
    1e-15,
    "sum",
  );
  assert.deepEqual(overbooked, []);
  const over = hourlyShares([
    { name: "a", mA: 1, every: 10, duration: 8 },
    { name: "b", mA: 1, every: 10, duration: 4, from: 0, to: 1 },
  ]);
  assert.deepEqual(over.overbooked, [0]);
  near(over.shares[0][0] + over.shares[0][1], 1, 1e-15, "scaled to 100 %");
});

test("efficiency curve interpolates in log(current) and holds at the ends", () => {
  /** @type {Array<[number, number]>} */
  const curve = [
    [0.01, 0.5],
    [1, 0.9],
  ];
  assert.equal(efficiencyAt(curve, 0.001), 0.5);
  assert.equal(efficiencyAt(curve, 10), 0.9);
  near(efficiencyAt(curve, 0.1), 0.7, 1e-12, "half way in log");
  assert.equal(efficiencyAt([], 5), 1);
});

test("daily budget of the ESP32 example by hand (LDO, 3.7 V nominal)", () => {
  const b = dailyBudget(ESP32, LDO, 3.7);
  near(b.states[0].hoursPerDay, 24 * 0.9945, 1e-9, "sleep hours");
  near(b.states[1].mAhPerDay, 40 * 0.0005 * 24, 1e-12, "read mAh");
  near(b.states[2].mAhPerDay, 120 * 0.005 * 24, 1e-12, "wifi mAh");
  // Battery side: LDO input current = load current + quiescent current.
  const mAh = 0.015 * 24 * 0.9945 + 0.48 + 14.4 + 0.0016 * 24;
  near(b.WhPerDay, (3.7 * mAh) / 1000, 1e-12, "Wh/day");
  near(b.mAhPerDay, mAh, 1e-9, "mAh/day at the battery");
  near(b.averageMa, mAh / 24, 1e-9, "average mA");
  // Supply side is at 3.3 V; the LDO burns the 0.4 V difference plus Iq.
  const supplyWh = (3.3 * (mAh - 0.0016 * 24)) / 1000;
  near(b.regulatorWhPerDay, b.WhPerDay - supplyWh, 1e-12, "regulator loss");
});

test("LDO vs buck: the buck wins on the radio burst, loses on light-load efficiency", () => {
  const ldo = hourLoads(ESP32, LDO)[0];
  const buck = hourLoads(ESP32, BUCK)[0];
  const vbat = 4.0;
  const pLdo = batteryPower(LDO, vbat, ldo.meanMa, ldo.convertedW);
  const pBuck = batteryPower(BUCK, vbat, buck.meanMa, buck.convertedW);
  // By hand: LDO = 4.0 V x (mean mA + 1.6 uA).
  near(pLdo, 4.0 * (ldo.meanMa / 1000 + 1.6e-6), 1e-15, "LDO power");
  // Buck = sum share x I x 3.3 / eta(I) + 4.0 V x 0.36 uA.
  const effSleep = efficiencyAt(BUCK.efficiency, 0.015);
  const hand =
    (0.9945 * 0.015e-3 * 3.3) / effSleep +
    (0.0005 * 40e-3 * 3.3) / efficiencyAt(BUCK.efficiency, 40) +
    (0.005 * 120e-3 * 3.3) / efficiencyAt(BUCK.efficiency, 120) +
    4.0 * 0.36e-6;
  near(pBuck, hand, 1e-15, "buck power");
  assert.ok(pBuck < pLdo, "a buck from 4.0 V beats an LDO on this duty cycle");
  // Pure sleep: 15 uA at 3.3 V through an ~81 % efficient buck costs more than the LDO.
  /** @type {LoadState[]} */
  const sleepOnly = [{ name: "sleep", mA: 0.015, base: true }];
  const s1 = hourLoads(sleepOnly, LDO)[0];
  const s2 = hourLoads(sleepOnly, BUCK)[0];
  const sleepLdo = batteryPower(LDO, 3.6, s1.meanMa, s1.convertedW);
  const sleepBuck = batteryPower(BUCK, 3.6, s2.meanMa, s2.convertedW);
  assert.ok(sleepBuck > sleepLdo, `${sleepBuck} vs ${sleepLdo}`);
});

test("no regulator: battery power is battery voltage x load current", () => {
  const h = hourLoads(ESP32, NONE)[0];
  near(batteryPower(NONE, 3.2, h.meanMa, h.convertedW), (3.2 * h.meanMa) / 1000, 1e-15, "direct");
  const b = dailyBudget(ESP32, NONE, 3.2);
  near(b.regulatorWhPerDay, 0, 1e-15, "no regulator overhead");
});

test("minimum battery voltage for each regulator type", () => {
  near(regulatorMinVin(LDO), 3.18, 1e-12, "low-Iq LDO: node minimum 3.0 + 0.18 dropout");
  near(regulatorMinVin(REGULATOR_PRESETS["ldo-ams1117"].regulator), 4.1, 1e-12, "AMS1117-class");
  assert.equal(regulatorMinVin(BUCK), BUCK.minVin);
  assert.equal(regulatorMinVin(NONE), NONE.nodeMinV);
  assert.equal(regulatorMinVin({ ...LDO, vout: 2.8, nodeMinV: 3.0 }), 2.8 + 0.18);
});

test("peak battery current", () => {
  near(peakBatteryMa(ESP32, LDO, 3.7), 120.0016, 1e-9, "LDO");
  assert.equal(peakBatteryMa(ESP32, NONE, 3.2), 120);
  near(
    peakBatteryMa(ESP32, BUCK, 3.7),
    (120 * 3.3) / (efficiencyAt(BUCK.efficiency, 120) * 3.7) + 0.00036,
    1e-9,
    "buck",
  );
});
