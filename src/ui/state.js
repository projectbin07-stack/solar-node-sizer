// URL parameters <-> configuration. DOM-free so it can be tested under Node.
// Only values that differ from the defaults are written, so links stay short.

import { ConfigError, defaultConfig, validate } from "../core/config.js";
import { REGULATOR_PRESETS } from "../core/load.js";

/** @typedef {import("../core/config.js").Config} Config */
/** @typedef {import("../core/load.js").LoadState} LoadState */

/**
 * URL key, section and field of each numeric setting.
 * @type {Array<[string, "location" | "panel" | "charger" | "battery" | "simulation" | "sizer", string]>}
 */
export const NUMERIC_KEYS = [
  ["lat", "location", "lat"],
  ["lon", "location", "lon"],
  ["tz", "location", "tz"],
  ["seed", "location", "seed"],
  ["cs", "location", "cloudScale"],
  ["wp", "panel", "wp"],
  ["tilt", "panel", "tilt"],
  ["az", "panel", "azimuth"],
  ["alb", "panel", "albedo"],
  ["tc", "panel", "tempCoeff"],
  ["noct", "panel", "noct"],
  ["soil", "panel", "soiling"],
  ["loss", "panel", "otherLosses"],
  ["vmp", "panel", "vmp"],
  ["che", "charger", "efficiency"],
  ["chi", "charger", "maxCurrentMa"],
  ["cells", "battery", "cells"],
  ["mah", "battery", "capacityMah"],
  ["dod", "battery", "dod"],
  ["cut", "battery", "cutoffV"],
  ["sd", "battery", "selfDischargePerMonth"],
  ["soc0", "battery", "initialSoc"],
  ["wu", "simulation", "warmupYears"],
  ["rf", "simulation", "restartFraction"],
  ["tgt", "sizer", "maxDowntimeHours"],
  ["cpw", "sizer", "costPerWp"],
  ["cpa", "sizer", "costPerAh"],
];

/** @type {Array<[string, keyof import("../core/load.js").Regulator]>} */
const REGULATOR_KEYS = [
  ["rvo", "vout"],
  ["riq", "iqUa"],
  ["rdo", "dropout"],
  ["rmin", "minVin"],
  ["rnode", "nodeMinV"],
];

/**
 * Compact number formatting for URLs: up to 6 significant digits.
 * @param {number} v
 * @returns {string}
 */
export function num(v) {
  return String(Number(v.toPrecision(6)));
}

/**
 * Names may not contain the separators used in the load parameter.
 * @param {string} name
 * @returns {string}
 */
function cleanName(name) {
  return name.replace(/[~;]/g, " ").trim().slice(0, 40) || "state";
}

/**
 * Load states as "name~mA~every~duration~from~to" joined by ";"; the base
 * state has "b" in place of the schedule.
 * @param {LoadState[]} states
 * @returns {string}
 */
export function encodeLoad(states) {
  return states
    .map((s) => {
      const head = `${cleanName(s.name)}~${num(s.mA)}`;
      if (s.base) return `${head}~b`;
      const parts = [head, num(s.every ?? 0), num(s.duration ?? 0)];
      if ((s.from ?? 0) !== 0 || (s.to ?? 24) !== 24) parts.push(num(s.from ?? 0), num(s.to ?? 24));
      return parts.join("~");
    })
    .join(";");
}

/**
 * @param {string} text
 * @returns {LoadState[] | null} null if anything is malformed
 */
export function decodeLoad(text) {
  /** @type {LoadState[]} */
  const out = [];
  for (const part of text.split(";")) {
    const f = part.split("~");
    if (f.length < 3) return null;
    const mA = Number(f[1]);
    if (!Number.isFinite(mA) || mA < 0 || f[1].trim() === "") return null;
    const name = cleanName(f[0]);
    if (f[2] === "b") {
      out.push({ name, mA, base: true });
      continue;
    }
    const nums = f.slice(2).map(Number);
    if (nums.length !== 2 && nums.length !== 4) return null;
    if (nums.some((x) => !Number.isFinite(x) || x < 0)) return null;
    /** @type {LoadState} */
    const s = { name, mA, every: nums[0], duration: nums[1] };
    if (nums.length === 4) {
      s.from = nums[2];
      s.to = nums[3];
    }
    out.push(s);
  }
  return out.length > 0 ? out : null;
}

/**
 * @typedef {object} UrlState
 * @property {Config} config
 * @property {"auto" | "light" | "dark"} theme
 * @property {string | null} example id of the example the setup started from
 *   (a label for the picker only; the configuration is always stored as
 *   differences from the default)
 * @property {string[]} ignored URL keys whose values were invalid and ignored
 */

/**
 * @param {UrlState} state
 * @returns {string} query string without the leading "?"
 */
export function encodeState(state) {
  const c = state.config;
  const d = defaultConfig();
  const q = new URLSearchParams();
  if (c.location.climate !== d.location.climate) q.set("cl", c.location.climate);
  for (const [key, section, field] of NUMERIC_KEYS) {
    const v = /** @type {Record<string, number>} */ (/** @type {unknown} */ (c[section]))[field];
    const dv = /** @type {Record<string, number>} */ (/** @type {unknown} */ (d[section]))[field];
    if (num(v) !== num(dv)) q.set(key, num(v));
  }
  if (c.charger.type !== d.charger.type) q.set("ch", c.charger.type);
  if (c.battery.chemistry !== d.battery.chemistry) q.set("chem", c.battery.chemistry);
  const presetId = c.regulatorPreset in REGULATOR_PRESETS ? c.regulatorPreset : "custom";
  if (presetId !== d.regulatorPreset) q.set("reg", presetId);
  const base =
    presetId === "custom"
      ? null
      : /** @type {import("../core/load.js").Regulator} */ (REGULATOR_PRESETS[presetId].regulator);
  if (!base || c.regulator.type !== base.type) q.set("rt", c.regulator.type);
  for (const [key, field] of REGULATOR_KEYS) {
    const v = /** @type {number} */ (c.regulator[field]);
    if (!base || num(v) !== num(/** @type {number} */ (base[field]))) q.set(key, num(v));
  }
  if (
    c.regulator.type === "switching" &&
    (!base || JSON.stringify(c.regulator.efficiency) !== JSON.stringify(base.efficiency))
  )
    q.set("reff", c.regulator.efficiency.map(([i, e]) => `${num(i)}:${num(e)}`).join(","));
  const load = encodeLoad(c.load);
  if (load !== encodeLoad(d.load)) q.set("L", load);
  if (c.sizer.panelWp.length > 0) q.set("pw", c.sizer.panelWp.map(num).join(","));
  if (c.sizer.batteryMah.length > 0) q.set("bm", c.sizer.batteryMah.map(num).join(","));
  if (state.example) q.set("ex", state.example);
  if (state.theme !== "auto") q.set("theme", state.theme);
  return q.toString();
}

/**
 * Parse "a,b,c" as positive numbers.
 * @param {string} s
 * @returns {number[] | null}
 */
function numberList(s) {
  const v = s.split(",").map((x) => Number(x));
  return v.length > 0 && v.every((x) => Number.isFinite(x) && x > 0) ? v : null;
}

/**
 * Read a configuration from URL parameters. Each parameter is applied on
 * its own; one that is malformed or makes the configuration invalid is
 * ignored (and reported) rather than rejecting the whole link.
 * @param {string} query
 * @returns {UrlState}
 */
export function decodeState(query) {
  const q = new URLSearchParams(query);
  const c = defaultConfig();
  /** @type {string[]} */
  const ignored = [];
  /**
   * @param {string} key
   * @param {(c: Config) => boolean} apply returns false if the value is malformed
   */
  const tryApply = (key, apply) => {
    if (!q.has(key)) return;
    const before = structuredClone(c);
    let ok = false;
    try {
      ok = apply(c);
      if (ok) validate(c);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      ok = false;
    }
    if (!ok) {
      Object.assign(c, before);
      ignored.push(key);
    }
  };
  const get = (/** @type {string} */ key) => /** @type {string} */ (q.get(key));

  tryApply("cl", (x) => ((x.location.climate = get("cl")), true));
  tryApply("chem", (x) => ((x.battery.chemistry = get("chem")), true));
  tryApply("ch", (x) => {
    const v = get("ch");
    if (v !== "mppt" && v !== "linear") return false;
    x.charger.type = v;
    return true;
  });
  tryApply("reg", (x) => {
    const id = get("reg");
    if (id === "custom") {
      x.regulatorPreset = "custom";
      return true;
    }
    const p = REGULATOR_PRESETS[id];
    if (!p) return false;
    x.regulatorPreset = id;
    x.regulator = structuredClone(p.regulator);
    return true;
  });
  tryApply("rt", (x) => {
    const v = get("rt");
    if (v !== "none" && v !== "ldo" && v !== "switching") return false;
    x.regulator.type = v;
    x.regulatorPreset = "custom";
    if (v === "switching" && x.regulator.efficiency.length === 0)
      x.regulator.efficiency = structuredClone(REGULATOR_PRESETS.buck.regulator.efficiency);
    return true;
  });
  for (const [key, section, field] of NUMERIC_KEYS) {
    tryApply(key, (x) => {
      const raw = get(key);
      const v = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(v)) return false;
      /** @type {Record<string, number>} */ (/** @type {unknown} */ (x[section]))[field] = v;
      return true;
    });
  }
  for (const [key, field] of REGULATOR_KEYS) {
    tryApply(key, (x) => {
      const raw = get(key);
      const v = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(v)) return false;
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (x.regulator))[field] = v;
      x.regulatorPreset = "custom";
      return true;
    });
  }
  tryApply("reff", (x) => {
    /** @type {Array<[number, number]>} */
    const pts = [];
    for (const p of get("reff").split(",")) {
      const [i, e] = p.split(":").map(Number);
      if (!Number.isFinite(i) || !Number.isFinite(e)) return false;
      pts.push([i, e]);
    }
    x.regulator.efficiency = pts;
    x.regulatorPreset = "custom";
    return true;
  });
  tryApply("L", (x) => {
    const load = decodeLoad(get("L"));
    if (!load) return false;
    x.load = load;
    return true;
  });
  tryApply("pw", (x) => {
    const v = numberList(get("pw"));
    if (!v) return false;
    x.sizer.panelWp = v;
    return true;
  });
  tryApply("bm", (x) => {
    const v = numberList(get("bm"));
    if (!v) return false;
    x.sizer.batteryMah = v;
    return true;
  });
  const t = q.get("theme");
  const theme = t === "light" || t === "dark" ? t : "auto";
  return { config: c, theme, example: q.get("ex"), ignored };
}
