import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ConfigError,
  batteryLimits,
  configWarnings,
  defaultConfig,
  normalizeConfig,
} from "../src/core/config.js";
import {
  buildResource,
  dayLabel,
  fmt,
  pct,
  resultJson,
  runModel,
  summarize,
  toCsv,
} from "../src/core/model.js";
import {
  autoGrid,
  minCapacityForPeak,
  nice,
  niceCeil,
  niceRange,
  size,
} from "../src/core/sizer.js";
import { prepare } from "../src/core/simulate.js";

/**
 * @param {string} name
 * @returns {unknown}
 */
function example(name) {
  return JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));
}

test("the default configuration is the ESP32 example", () => {
  assert.deepEqual(normalizeConfig(example("esp32-wifi-10min.json")), defaultConfig());
  assert.deepEqual(normalizeConfig(undefined), defaultConfig());
});

test("every example is valid and labelled illustrative", () => {
  for (const f of ["esp32-wifi-10min.json", "atmega-nrf24.json", "esp32-devboard-ams1117.json"]) {
    const c = normalizeConfig(example(f));
    assert.match(c.name, /illustrative/);
    assert.match(c.note, /[Ii]llustrative/);
  }
});

test("chemistry and cell count set the matching defaults before explicit fields", () => {
  const c = normalizeConfig({ battery: { chemistry: "lifepo4", cells: 2 } });
  assert.equal(c.battery.dod, 0.9);
  assert.equal(c.battery.cutoffV, 5.6);
  const nimh = normalizeConfig({ battery: { chemistry: "nimh", cells: 3, dod: 0.5 } });
  assert.equal(nimh.battery.dod, 0.5);
  assert.equal(nimh.battery.selfDischargePerMonth, 0.2);
  assert.ok(
    configWarnings({ ...nimh, charger: { ...nimh.charger, type: "mppt" } }).some((w) =>
      /NiMH/.test(w),
    ),
  );
});

test("regulator preset and overrides", () => {
  const c = normalizeConfig({ regulatorPreset: "buck", regulator: { minVin: 3.3 } });
  assert.equal(c.regulator.type, "switching");
  assert.equal(c.regulator.minVin, 3.3);
  const custom = normalizeConfig({ regulator: { iqUa: 10 } });
  assert.equal(custom.regulatorPreset, "custom");
  const named = normalizeConfig({
    regulatorPreset: "custom",
    regulator: { type: "none", nodeMinV: 1.8 },
  });
  assert.equal(named.regulator.type, "none");
});

test("invalid configurations give specific errors", () => {
  /** @type {Array<[unknown, RegExp]>} */
  const cases = [
    [[], /JSON object/],
    [{ colour: 1 }, /unknown field colour/],
    [{ panel: { wp: "big" } }, /panel.wp must be a number/],
    [{ panel: { size: 1 } }, /unknown field panel.size/],
    [{ panel: 3 }, /panel must be an object/],
    [{ name: 3, location: { lat: 95 } }, /lat must be/],
    [{ location: { climate: "mars" } }, /climate must be one of/],
    [{ location: { seed: 1.5 } }, /seed must be an integer/],
    [{ battery: { chemistry: "lead" } }, /unknown chemistry/],
    [{ regulatorPreset: "magic" }, /unknown regulatorPreset/],
    [{ regulatorPreset: 7 }, /must be a string/],
    [{ load: [] }, /non-empty array/],
    [{ load: [{ name: "x", mA: -1 }] }, /mA must be/],
    [{ load: [{ name: "x", mA: 1 }] }, /needs "every" and "duration"/],
    [{ load: [{ name: "x", mA: 1, every: 10, duration: 1, from: 30 }] }, /hours must be 0..24/],
    [{ load: [{ name: "x", mA: 1, every: -1, duration: 1 }] }, /every must be/],
    [{ load: ["x"] }, /must be an object/],
    [{ load: [{ mA: 1 }] }, /name must be a string/],
    [
      {
        load: [
          { name: "a", mA: 1, base: true },
          { name: "b", mA: 1, base: true },
        ],
      },
      /at most one/,
    ],
    [{ charger: { type: "pwm" } }, /charger.type/],
    [{ sizer: { panelWp: [1, -1] } }, /panelWp must be positive/],
    [{ sizer: { panelWp: 3 } }, /must be an array/],
    [{ sizer: { panelWp: Array(30).fill(1), batteryMah: Array(30).fill(1) } }, /limited to 400/],
    [
      {
        regulatorPreset: "buck",
        regulator: {
          efficiency: [
            [1, 0.9],
            [0.5, 0.8],
          ],
        },
      },
      /must increase/,
    ],
    [{ regulatorPreset: "buck", regulator: { efficiency: [[1, 1.5]] } }, /efficiency points/],
    [{ regulator: { name: 3 } }, /unknown field regulator.name/],
    [{ note: "x", panel: { otherLosses: 1 } }, /otherLosses/],
  ];
  for (const [raw, re] of cases)
    assert.throws(
      () => normalizeConfig(raw),
      (e) => e instanceof ConfigError && re.test(e.message),
      JSON.stringify(raw),
    );
  assert.throws(() => normalizeConfig({ regulator: { type: 5 } }), /must be a string/);
});

test("battery limits: depth of discharge, cut-off voltage or regulator sets the floor", () => {
  const c = defaultConfig();
  const dod = batteryLimits(c);
  assert.equal(dod.limitedBy, "dod");
  assert.equal(dod.socMin, 0.19999999999999996);
  const cut = batteryLimits({ ...c, battery: { ...c.battery, cutoffV: 3.62 } });
  assert.equal(cut.limitedBy, "cutoff");
  assert.ok(Math.abs(cut.socMin - 0.3) < 1e-9);
  const ams = normalizeConfig(example("esp32-devboard-ams1117.json"));
  const lim = batteryLimits(ams);
  assert.equal(lim.limitedBy, "regulator");
  assert.ok(lim.socMin > 0.9);
  const w = configWarnings(ams);
  assert.ok(w.some((x) => /needs at least 4.10 V/.test(x)));
  assert.ok(w.some((x) => /5.0 mA all the time/.test(x)));
  const never = normalizeConfig({ regulator: { dropout: 1.5 } });
  assert.ok(configWarnings(never).some((x) => /can never run/.test(x)));
});

test("other warnings: direct supply over 3.6 V, linear charger voltage, peak current", () => {
  const direct = normalizeConfig({ regulatorPreset: "none" });
  assert.ok(configWarnings(direct).some((x) => /up to 4.18 V/.test(x)));
  const lowVmp = normalizeConfig({ panel: { vmp: 4.3 } });
  assert.ok(configWarnings(lowVmp).some((x) => /cannot finish charging/.test(x)));
  const highVmp = normalizeConfig({ panel: { vmp: 18 } });
  assert.ok(configWarnings(highVmp).some((x) => /MPPT charger would do better/.test(x)));
  const tiny = normalizeConfig({ battery: { capacityMah: 40 } });
  assert.ok(configWarnings(tiny).some((x) => /peak load of about 120 mA/.test(x)));
  assert.ok(configWarnings(tiny).some((x) => /accept only 20 mA/.test(x)));
});

test("nice numbers for the automatic grids", () => {
  assert.equal(nice(0.0021), 0.002);
  assert.equal(nice(2.6), 3);
  assert.equal(nice(9), 10);
  assert.equal(nice(6.5), 7.5);
  assert.equal(niceCeil(60), 75);
  assert.equal(niceCeil(50), 50);
  assert.equal(niceCeil(8), 10);
  const r = niceRange(60, 800, 10);
  assert.ok(r[0] >= 60);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
});

test("automatic grid scales with the load and respects the peak current", () => {
  const c = defaultConfig();
  const res = buildResource(c);
  const g = autoGrid(c, prepare(c, res));
  assert.ok(g.panelWp.length >= 8);
  assert.ok(g.batteryMah[0] >= minCapacityForPeak(c), `${g.batteryMah[0]}`);
  assert.equal(minCapacityForPeak(c), 120.0016 / 2);
});

test("sizer: more panel never increases downtime (default model, three climates)", () => {
  for (const [lat, lon, tz, climate] of /** @type {Array<[number, number, number, string]>} */ ([
    [12.97, 77.59, 5.5, "bengaluru"],
    [19.08, 72.88, 5.5, "mumbai"],
    [52.52, 13.41, 1, "berlin"],
  ])) {
    const c = normalizeConfig({ location: { lat, lon, tz, climate } });
    const s = size(c, buildResource(c));
    for (let j = 0; j < s.batteryMah.length; j++)
      for (let i = 1; i < s.panelWp.length; i++)
        assert.ok(
          s.downtime[i][j] <= s.downtime[i - 1][j] + 1e-9,
          `${climate}: ${s.panelWp[i]} Wp / ${s.batteryMah[j]} mAh: ${s.downtime[i - 1][j]} -> ${s.downtime[i][j]}`,
        );
  }
});

test("sizer: more battery never increases downtime without self-discharge or restart margin", () => {
  // With self-discharge (proportional to stored energy) or a restart margin
  // (proportional to capacity) a bigger battery can lose slightly more when
  // the panel is far too small; see docs/models.md. Without them the
  // hourly update is monotonic in stored energy.
  for (const climate of ["bengaluru", "berlin"]) {
    const c = normalizeConfig({
      location: climate === "berlin" ? { lat: 52.52, lon: 13.41, tz: 1, climate } : { climate },
      battery: { selfDischargePerMonth: 0 },
      simulation: { restartFraction: 0, warmupYears: 1 },
    });
    const s = size(c, buildResource(c));
    for (let i = 0; i < s.panelWp.length; i++)
      for (let j = 1; j < s.batteryMah.length; j++)
        assert.ok(
          s.downtime[i][j] <= s.downtime[i][j - 1] + 1e-9,
          `${climate}: ${s.panelWp[i]} Wp / ${s.batteryMah[j]} mAh: ${s.downtime[i][j - 1]} -> ${s.downtime[i][j]}`,
        );
  }
});

test("sizer: frontier is non-dominated, meets the target, best is the cheapest", () => {
  const c = normalizeConfig(example("esp32-devboard-ams1117.json"));
  const s = size(c, buildResource(c));
  assert.equal(s.runs, s.panelWp.length * s.batteryMah.length);
  assert.ok(s.frontier.length >= 2);
  for (let k = 1; k < s.frontier.length; k++) {
    assert.ok(s.frontier[k].wp > s.frontier[k - 1].wp);
    assert.ok(s.frontier[k].capacityMah < s.frontier[k - 1].capacityMah);
  }
  for (const p of s.frontier) assert.ok(p.downtimeHours <= s.target);
  assert.ok(s.best);
  for (let i = 0; i < s.panelWp.length; i++)
    for (let j = 0; j < s.batteryMah.length; j++)
      if (s.downtime[i][j] <= s.target && !s.peakLimited[j])
        assert.ok(s.panelWp[i] + s.batteryMah[j] / 1000 >= s.best.cost - 1e-9);
  // An explicit grid is used as given (sorted, de-duplicated).
  const g = size(
    { ...c, sizer: { ...c.sizer, panelWp: [2, 1, 2], batteryMah: [3000] } },
    buildResource(c),
  );
  assert.deepEqual(g.panelWp, [1, 2]);
  const none = size(
    { ...c, sizer: { ...c.sizer, panelWp: [0.01], batteryMah: [100] } },
    buildResource(c),
  );
  assert.equal(none.best, null);
  assert.deepEqual(none.frontier, []);
});

test("model run: summary sentences, JSON shape, CSV export", () => {
  const ok = runModel(defaultConfig());
  assert.match(ok.summary, /^Survives the year with \d+ days of autonomy/);
  const down = runModel(normalizeConfig({ panel: { wp: 0.02 } }));
  assert.match(down.summary, /^Down \d+ hours over the year, mostly in [A-Z][a-z]{2} \([\d.]+ %\)/);
  const j = resultJson(defaultConfig(), ok);
  for (const k of [
    "summary",
    "battery",
    "budget",
    "totalsWh",
    "downtimeHours",
    "months",
    "worstDeficit",
    "warnings",
  ])
    assert.ok(k in j, k);
  const csv = toCsv(ok.resource, ok.result).trim().split("\n");
  assert.equal(csv.length, 8761);
  assert.equal(csv[0], "local_time,poa_w_m2,air_temp_c,panel_w,stored_w,load_w,down_fraction,soc");
  assert.match(csv[13], /^2025-01-01 12:00,/);
  assert.equal(dayLabel(Date.UTC(2025, 0, 1), 31), "1 Feb");
  assert.equal(fmt(1234.5), "1235");
  assert.equal(fmt(12.34), "12.3");
  assert.equal(fmt(0.5), "0.5");
  assert.equal(fmt(0.0075), "0.0075");
  assert.equal(fmt(75), "75");
  assert.equal(fmt(0), "0");
  assert.equal(fmt(Infinity), "Infinity");
  assert.equal(pct(0.257), "25.7 %");
  assert.equal(pct(0.25), "25 %");
});

test("summary for a non-year span and a single-month outage", () => {
  const base = runModel(defaultConfig()).result;
  const months = base.months.map((m) => ({ ...m, downtimeHours: 0 }));
  months[6].downtimeHours = 5;
  const s = summarize({
    ...base,
    days: 30,
    downtimeHours: 5,
    downtimeEvents: 1,
    longestOutageHours: 5,
    months,
  });
  assert.match(s, /^Down 5 hours over the 30 simulated days, all in Jul; 1 brown-out\(s\)/);
});
