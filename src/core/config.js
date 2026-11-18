// The configuration shared by the CLI (JSON files) and the browser app (URL
// parameters): defaults, validation and derived battery limits.

import { getChemistry, ocv, socAtVoltage } from "./battery.js";
import { REGULATOR_PRESETS, peakBatteryMa, regulatorMinVin } from "./load.js";
import { CLIMATES } from "./weather.js";

/** @typedef {import("./load.js").LoadState} LoadState */
/** @typedef {import("./load.js").Regulator} Regulator */
/** @typedef {import("./pv.js").Panel} Panel */
/** @typedef {import("./pv.js").Charger} Charger */

/**
 * @typedef {object} Location
 * @property {number} lat
 * @property {number} lon
 * @property {number} tz hours east of UTC
 * @property {string} climate synthetic climate preset id
 * @property {number} seed
 * @property {number} cloudScale
 */

/**
 * @typedef {object} BatteryConfig
 * @property {string} chemistry
 * @property {number} cells in series
 * @property {number} capacityMah
 * @property {number} dod usable depth of discharge, 0..1
 * @property {number} cutoffV low-voltage cut-off of the pack, V
 * @property {number} selfDischargePerMonth fraction per month
 * @property {number} initialSoc 0..1
 */

/**
 * @typedef {object} SimulationConfig
 * @property {number} warmupYears years simulated first to reach a steady state
 * @property {number} restartFraction after a brown-out the node restarts once this
 *   fraction of the usable window has been recharged
 */

/**
 * @typedef {object} SizerConfig
 * @property {number[]} panelWp grid to search; empty = chosen from the load
 * @property {number[]} batteryMah grid to search; empty = chosen from the load
 * @property {number} maxDowntimeHours
 * @property {number} costPerWp relative cost of one watt of panel
 * @property {number} costPerAh relative cost of one amp-hour of battery (whole pack)
 */

/**
 * @typedef {object} Config
 * @property {string} name
 * @property {string} note
 * @property {Location} location
 * @property {Panel} panel
 * @property {Charger} charger
 * @property {BatteryConfig} battery
 * @property {string} regulatorPreset preset id, or "custom"
 * @property {Regulator} regulator
 * @property {LoadState[]} load
 * @property {SimulationConfig} simulation
 * @property {SizerConfig} sizer
 */

/** @returns {Config} */
export function defaultConfig() {
  // Same as examples/esp32-wifi-10min.json (a test keeps them in step).
  return {
    name: "ESP32 + BME280, Wi-Fi report every 10 min, Bengaluru (illustrative)",
    note: "Illustrative example, not a measured node. Currents are datasheet-order figures for an ESP32 module on a board with a low-Iq LDO; measure your own board.",
    location: { lat: 12.97, lon: 77.59, tz: 5.5, climate: "bengaluru", seed: 1, cloudScale: 1 },
    panel: {
      wp: 1,
      tilt: 15,
      azimuth: 180,
      albedo: 0.2,
      tempCoeff: -0.004,
      noct: 48,
      soiling: 0.05,
      otherLosses: 0.1,
      vmp: 6,
    },
    charger: { type: "linear", efficiency: 0.97, maxCurrentMa: 500 },
    battery: {
      chemistry: "liion",
      cells: 1,
      capacityMah: 2500,
      dod: 0.8,
      cutoffV: 3.0,
      selfDischargePerMonth: 0.03,
      initialSoc: 1,
    },
    regulatorPreset: "ldo-lowiq",
    regulator: structuredClone(REGULATOR_PRESETS["ldo-lowiq"].regulator),
    load: [
      { name: "Deep sleep (RTC timer)", mA: 0.015, base: true },
      { name: "Boot + BME280 read", mA: 40, every: 600, duration: 0.3 },
      { name: "Wi-Fi connect + MQTT", mA: 120, every: 600, duration: 3 },
    ],
    simulation: { warmupYears: 1, restartFraction: 0.05 },
    sizer: { panelWp: [], batteryMah: [], maxDowntimeHours: 0, costPerWp: 1, costPerAh: 1 },
  };
}

export class ConfigError extends Error {}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge numeric/string fields of `src` over `dst` where the types match.
 * @param {Record<string, unknown>} dst
 * @param {unknown} src
 * @param {string} path
 */
function mergeFields(dst, src, path) {
  if (src === undefined) return;
  if (!isObject(src)) throw new ConfigError(`${path} must be an object`);
  for (const [k, v] of Object.entries(src)) {
    if (!(k in dst)) throw new ConfigError(`unknown field ${path}.${k}`);
    const cur = dst[k];
    if (typeof cur === "number") {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new ConfigError(`${path}.${k} must be a number`);
      dst[k] = v;
    } else if (typeof cur === "string") {
      if (typeof v !== "string") throw new ConfigError(`${path}.${k} must be a string`);
      dst[k] = v;
    } else if (Array.isArray(cur)) {
      if (!Array.isArray(v)) throw new ConfigError(`${path}.${k} must be an array`);
      dst[k] = v;
    }
  }
}

/**
 * Build a full configuration from a partial one (JSON from a file or the
 * URL), filling defaults and checking ranges.
 * @param {unknown} raw
 * @returns {Config}
 */
export function normalizeConfig(raw) {
  const c = defaultConfig();
  if (raw === undefined || raw === null) return c;
  if (!isObject(raw)) throw new ConfigError("configuration must be a JSON object");
  const known = new Set(Object.keys(c));
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new ConfigError(`unknown field ${k}`);
  if (typeof raw.name === "string") c.name = raw.name;
  if (typeof raw.note === "string") c.note = raw.note;
  mergeFields(/** @type {any} */ (c.location), raw.location, "location");
  mergeFields(/** @type {any} */ (c.panel), raw.panel, "panel");
  mergeFields(/** @type {any} */ (c.charger), raw.charger, "charger");
  if (
    isObject(raw.battery) &&
    (raw.battery.chemistry !== undefined || raw.battery.cells !== undefined)
  ) {
    const chem = getChemistrySafe(
      typeof raw.battery.chemistry === "string" ? raw.battery.chemistry : c.battery.chemistry,
    );
    c.battery.chemistry = chem.id;
    c.battery.dod = chem.defaultDod;
    c.battery.selfDischargePerMonth = chem.selfDischargePerMonth;
    const cells = typeof raw.battery.cells === "number" ? raw.battery.cells : 1;
    c.battery.cutoffV = chem.defaultCutoffCell * cells;
  }
  mergeFields(/** @type {any} */ (c.battery), raw.battery, "battery");
  mergeFields(/** @type {any} */ (c.simulation), raw.simulation, "simulation");
  mergeFields(/** @type {any} */ (c.sizer), raw.sizer, "sizer");
  if (raw.regulatorPreset !== undefined) {
    if (typeof raw.regulatorPreset !== "string")
      throw new ConfigError("regulatorPreset must be a string");
    if (raw.regulatorPreset !== "custom") {
      const preset = REGULATOR_PRESETS[raw.regulatorPreset];
      if (!preset)
        throw new ConfigError(
          `unknown regulatorPreset '${raw.regulatorPreset}' (known: ${Object.keys(REGULATOR_PRESETS).join(", ")}, custom)`,
        );
      c.regulator = structuredClone(preset.regulator);
    }
    c.regulatorPreset = raw.regulatorPreset;
  }
  if (raw.regulator !== undefined) {
    mergeFields(/** @type {any} */ (c.regulator), raw.regulator, "regulator");
    if (raw.regulatorPreset === undefined) c.regulatorPreset = "custom";
  }
  if (raw.load !== undefined) c.load = normalizeLoad(raw.load);
  validate(c);
  return c;
}

/**
 * @param {string} id
 * @returns {import("./battery.js").Chemistry}
 */
function getChemistrySafe(id) {
  try {
    return getChemistry(id);
  } catch (e) {
    throw new ConfigError(/** @type {Error} */ (e).message);
  }
}

/**
 * @param {unknown} raw
 * @returns {LoadState[]}
 */
export function normalizeLoad(raw) {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new ConfigError("load must be a non-empty array of states");
  return raw.map((s, i) => {
    if (!isObject(s)) throw new ConfigError(`load[${i}] must be an object`);
    if (typeof s.name !== "string") throw new ConfigError(`load[${i}].name must be a string`);
    if (typeof s.mA !== "number" || !(s.mA >= 0))
      throw new ConfigError(`load[${i}].mA must be a number >= 0`);
    /** @type {LoadState} */
    const out = { name: s.name, mA: s.mA };
    if (s.base === true) out.base = true;
    for (const k of /** @type {const} */ (["every", "duration", "from", "to"])) {
      const v = s[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw new ConfigError(`load[${i}].${k} must be a number >= 0`);
      out[k] = v;
    }
    if (!out.base && !(out.every && out.every > 0 && out.duration !== undefined))
      throw new ConfigError(`load[${i}] needs "every" and "duration" (seconds), or "base": true`);
    if ((out.from ?? 0) > 24 || (out.to ?? 24) > 24)
      throw new ConfigError(`load[${i}] hours must be 0..24`);
    return out;
  });
}

/**
 * @param {boolean} ok
 * @param {string} message
 */
function check(ok, message) {
  if (!ok) throw new ConfigError(message);
}

/**
 * Range checks that would otherwise give nonsense rather than an error.
 * @param {Config} c
 */
export function validate(c) {
  const { location: l, panel: p, charger: ch, battery: b, regulator: r, sizer: s } = c;
  check(l.lat >= -90 && l.lat <= 90, "location.lat must be -90..90");
  check(l.lon >= -180 && l.lon <= 180, "location.lon must be -180..180");
  check(l.tz >= -12 && l.tz <= 14, "location.tz must be -12..14 hours");
  check(
    CLIMATES.some((x) => x.id === l.climate),
    `location.climate must be one of ${CLIMATES.map((x) => x.id).join(", ")}`,
  );
  check(Number.isInteger(l.seed), "location.seed must be an integer");
  check(l.cloudScale > 0 && l.cloudScale <= 2, "location.cloudScale must be in (0, 2]");
  check(p.wp >= 0 && p.wp <= 1000, "panel.wp must be 0..1000");
  check(p.tilt >= 0 && p.tilt <= 90, "panel.tilt must be 0..90");
  check(p.azimuth >= 0 && p.azimuth < 360, "panel.azimuth must be 0..360 (180 = south)");
  check(p.albedo >= 0 && p.albedo <= 1, "panel.albedo must be 0..1");
  check(p.tempCoeff > -0.02 && p.tempCoeff <= 0, "panel.tempCoeff must be -0.02..0 per K");
  check(p.noct >= 20 && p.noct <= 80, "panel.noct must be 20..80 degC");
  check(p.soiling >= 0 && p.soiling < 1, "panel.soiling must be 0..1");
  check(p.otherLosses >= 0 && p.otherLosses < 1, "panel.otherLosses must be 0..1");
  check(p.vmp > 0, "panel.vmp must be > 0");
  check(ch.type === "mppt" || ch.type === "linear", "charger.type must be mppt or linear");
  check(ch.efficiency > 0 && ch.efficiency <= 1, "charger.efficiency must be in (0, 1]");
  check(ch.maxCurrentMa > 0, "charger.maxCurrentMa must be > 0");
  getChemistrySafe(b.chemistry);
  check(Number.isInteger(b.cells) && b.cells >= 1 && b.cells <= 16, "battery.cells must be 1..16");
  check(b.capacityMah > 0, "battery.capacityMah must be > 0");
  check(b.dod > 0 && b.dod <= 1, "battery.dod must be in (0, 1]");
  check(b.cutoffV >= 0, "battery.cutoffV must be >= 0");
  check(
    b.selfDischargePerMonth >= 0 && b.selfDischargePerMonth < 1,
    "battery.selfDischargePerMonth must be 0..1",
  );
  check(b.initialSoc >= 0 && b.initialSoc <= 1, "battery.initialSoc must be 0..1");
  check(
    ["none", "ldo", "switching"].includes(r.type),
    "regulator.type must be none, ldo or switching",
  );
  check(r.iqUa >= 0, "regulator.iqUa must be >= 0");
  check(r.nodeMinV >= 0 && r.dropout >= 0 && r.minVin >= 0, "regulator voltages must be >= 0");
  check(r.type === "none" || r.vout > 0, "regulator.vout must be > 0");
  if (r.type === "switching") {
    check(
      r.efficiency.length > 0,
      "regulator.efficiency needs at least one [mA, efficiency] point",
    );
    for (const pt of r.efficiency)
      check(
        Array.isArray(pt) && pt.length === 2 && pt[0] > 0 && pt[1] > 0 && pt[1] <= 1,
        "regulator.efficiency points must be [mA > 0, 0 < efficiency <= 1]",
      );
    for (let i = 1; i < r.efficiency.length; i++)
      check(
        r.efficiency[i][0] > r.efficiency[i - 1][0],
        "regulator.efficiency currents must increase",
      );
  }
  check(c.load.filter((st) => st.base).length <= 1, "at most one load state can be the base state");
  check(
    c.simulation.warmupYears >= 0 && c.simulation.warmupYears <= 5,
    "simulation.warmupYears must be 0..5",
  );
  check(
    c.simulation.restartFraction >= 0 && c.simulation.restartFraction < 1,
    "simulation.restartFraction must be 0..1",
  );
  check(
    s.panelWp.every((x) => typeof x === "number" && x > 0),
    "sizer.panelWp must be positive numbers (or empty for an automatic grid)",
  );
  check(
    s.batteryMah.every((x) => typeof x === "number" && x > 0),
    "sizer.batteryMah must be positive numbers (or empty for an automatic grid)",
  );
  check(s.panelWp.length * s.batteryMah.length <= 400, "sizer grid is limited to 400 combinations");
  check(s.maxDowntimeHours >= 0, "sizer.maxDowntimeHours must be >= 0");
}

/**
 * @typedef {object} BatteryLimits
 * @property {number} capacityWh at the nominal voltage
 * @property {number} vnom pack nominal voltage
 * @property {number} vmax pack voltage at full charge
 * @property {number} socMin lowest usable state of charge
 * @property {"dod" | "cutoff" | "regulator"} limitedBy which constraint sets socMin
 * @property {number} usableWh at 20 degC and above
 */

/**
 * Usable window of the battery: the highest of the depth-of-discharge
 * floor, the cut-off voltage and the regulator's minimum input voltage.
 * @param {Config} c
 * @param {number} [capacityMah] override (used by the sizer)
 * @returns {BatteryLimits}
 */
export function batteryLimits(c, capacityMah = c.battery.capacityMah) {
  const chem = getChemistry(c.battery.chemistry);
  const cells = c.battery.cells;
  const vnom = chem.vnomCell * cells;
  const capacityWh = (capacityMah / 1000) * vnom;
  const fromDod = 1 - c.battery.dod;
  const fromCutoff = socAtVoltage(chem, cells, c.battery.cutoffV);
  const minVin = regulatorMinVin(c.regulator);
  const fromReg = minVin > 0 ? socAtVoltage(chem, cells, minVin) : 0;
  /** @type {"dod" | "cutoff" | "regulator"} */
  let limitedBy = "dod";
  let socMin = fromDod;
  if (fromCutoff > socMin + 1e-9) {
    socMin = fromCutoff;
    limitedBy = "cutoff";
  }
  if (fromReg > socMin + 1e-9) {
    socMin = fromReg;
    limitedBy = "regulator";
  }
  return {
    capacityWh,
    vnom,
    vmax: ocv(chem, cells, 1),
    socMin,
    limitedBy,
    usableWh: capacityWh * Math.max(0, 1 - socMin),
  };
}

/**
 * Plain-language warnings about the combination of parts.
 * @param {Config} c
 * @returns {string[]}
 */
export function configWarnings(c) {
  /** @type {string[]} */
  const w = [];
  const lim = batteryLimits(c);
  const minVin = regulatorMinVin(c.regulator);
  if (lim.socMin >= 0.999)
    w.push(
      `The regulator needs ${minVin.toFixed(2)} V but a full battery only reaches ${lim.vmax.toFixed(2)} V: the node can never run.`,
    );
  else if (lim.limitedBy === "regulator")
    w.push(
      `The regulator needs at least ${minVin.toFixed(2)} V, so only ${Math.round((1 - lim.socMin) * 100)} % of the battery is usable (below that the output sags).`,
    );
  if (c.regulator.type === "none" && lim.vmax > 3.6)
    w.push(
      `No regulator: the node sees up to ${lim.vmax.toFixed(2)} V from a full battery. Check the maximum supply voltage of every part (many 3.3 V radios allow 3.6 V).`,
    );
  if (c.regulator.type === "ldo" && c.regulator.iqUa >= 1000)
    w.push(
      `The regulator draws ${(c.regulator.iqUa / 1000).toFixed(1)} mA all the time, which usually dominates a sleeping node's budget.`,
    );
  if (c.charger.type === "linear" && c.panel.vmp < lim.vmax + 0.3)
    w.push(
      `Panel Vmp (${c.panel.vmp} V) is close to or below the full battery voltage (${lim.vmax.toFixed(2)} V): a linear charger cannot finish charging.`,
    );
  if (c.charger.type === "linear" && c.panel.vmp > 2 * lim.vmax)
    w.push(
      `A linear charger wastes most of a ${c.panel.vmp} V panel's power on a ${lim.vnom.toFixed(1)} V battery; an MPPT charger would do better.`,
    );
  const chem = getChemistry(c.battery.chemistry);
  if (c.battery.chemistry.startsWith("nimh") && c.charger.type === "mppt")
    w.push(
      "NiMH needs a charge termination method suited to it; check that the charger supports NiMH.",
    );
  if (c.charger.maxCurrentMa / 1000 > chem.maxChargeC * (c.battery.capacityMah / 1000) * 1.5)
    w.push(
      `The charger can push ${c.charger.maxCurrentMa} mA but the model lets this battery accept only ${Math.round(chem.maxChargeC * c.battery.capacityMah)} mA (${chem.maxChargeC} C).`,
    );
  const peak = peakBatteryMa(c.load, c.regulator, lim.vnom);
  if (peak > chem.maxDischargeC * c.battery.capacityMah)
    w.push(
      `The peak load of about ${Math.round(peak)} mA is more than ${chem.maxDischargeC} C for a ${c.battery.capacityMah} mAh battery; the voltage will sag. Use a bigger cell or a buffer capacitor.`,
    );
  return w;
}
