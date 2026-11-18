// Glue used by both the CLI and the browser app: configuration + optional
// PVGIS data -> resource -> simulation, budget and a plain-language summary.

import { batteryLimits, configWarnings } from "./config.js";
import { getChemistry } from "./battery.js";
import { dailyBudget } from "./load.js";
import { pvgisResource, syntheticResource } from "./resource.js";
import { prepare, simulate } from "./simulate.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./pvgis.js").PvgisData} PvgisData */
/** @typedef {import("./resource.js").Resource} Resource */
/** @typedef {import("./simulate.js").SimResult} SimResult */

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * @param {Config} c
 * @param {PvgisData | null} [pvgis]
 * @returns {Resource}
 */
export function buildResource(c, pvgis = null) {
  if (pvgis)
    return pvgisResource(pvgis, {
      tz: c.location.tz,
      tilt: c.panel.tilt,
      azimuth: c.panel.azimuth,
      albedo: c.panel.albedo,
    });
  return syntheticResource({
    lat: c.location.lat,
    lon: c.location.lon,
    tz: c.location.tz,
    tilt: c.panel.tilt,
    azimuth: c.panel.azimuth,
    albedo: c.panel.albedo,
    climate: c.location.climate,
    seed: c.location.seed,
    cloudScale: c.location.cloudScale,
  });
}

/**
 * @typedef {object} ModelRun
 * @property {Resource} resource
 * @property {import("./simulate.js").Prepared} prepared
 * @property {SimResult} result
 * @property {import("./load.js").DailyBudget} budget
 * @property {string[]} warnings
 * @property {string} summary
 */

/**
 * @param {Config} c
 * @param {PvgisData | null} [pvgis]
 * @returns {ModelRun}
 */
export function runModel(c, pvgis = null) {
  const resource = buildResource(c, pvgis);
  const prepared = prepare(c, resource);
  const result = simulate(c, prepared);
  const lim = batteryLimits(c);
  const budget = dailyBudget(c.load, c.regulator, lim.vnom);
  const warnings = [...configWarnings(c), ...resource.notes];
  if (budget.overbookedHours.length > 0)
    warnings.push(
      `Scheduled states add up to more than 100 % of hour(s) ${budget.overbookedHours.join(", ")}; they were scaled down.`,
    );
  return { resource, prepared, result, budget, warnings, summary: summarize(result) };
}

/**
 * Format a day index as "12 Jul".
 * @param {number} startMs
 * @param {number} day
 * @returns {string}
 */
export function dayLabel(startMs, day) {
  const d = new Date(startMs + day * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * One-sentence verdict.
 * @param {SimResult} r
 * @returns {string}
 */
export function summarize(r) {
  const span = r.days >= 360 && r.days <= 370 ? "the year" : `the ${r.days} simulated days`;
  const autonomy = Number.isFinite(r.autonomyDays)
    ? `${fmt(r.autonomyDays)} days of autonomy`
    : "no load";
  if (r.downtimeHours < 0.05) {
    return `Survives ${span} with ${autonomy} from a full battery; lowest state of charge ${pct(r.minSoc)} around ${dayLabel(r.startMs, Math.floor(r.minSocHour / 24))}.`;
  }
  let worst = 0;
  r.months.forEach((m, i) => {
    if (m.downtimeHours > r.months[worst].downtimeHours) worst = i;
  });
  const share = r.months[worst].downtimeHours / r.downtimeHours;
  const where =
    share > 0.999 ? `all in ${MONTHS[worst]}` : `mostly in ${MONTHS[worst]} (${pct(share)})`;
  return `Down ${fmt(r.downtimeHours)} hours over ${span}, ${where}; ${r.downtimeEvents} brown-out(s), longest ${fmt(r.longestOutageHours)} h. Battery gives ${autonomy}.`;
}

/**
 * @param {number} x
 * @returns {string}
 */
export function fmt(x) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return String(Number(x.toFixed(1)));
  return String(Number(x.toPrecision(3)));
}

/**
 * @param {number} x fraction
 * @returns {string}
 */
export function pct(x) {
  const v = Math.round(x * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} %`;
}

/**
 * Hourly results as CSV text (local time).
 * @param {Resource} res
 * @param {SimResult} r
 * @returns {string}
 */
export function toCsv(res, r) {
  const lines = ["local_time,poa_w_m2,air_temp_c,panel_w,stored_w,load_w,down_fraction,soc"];
  for (let h = 0; h < r.hours; h++) {
    const t = new Date(r.startMs + h * 3600000).toISOString().slice(0, 16).replace("T", " ");
    lines.push(
      [
        t,
        res.poa[h].toFixed(1),
        res.tAmb[h].toFixed(1),
        r.pvW[h].toFixed(4),
        r.chargeW[h].toFixed(4),
        r.loadW[h].toFixed(5),
        r.down[h].toFixed(3),
        r.soc[h].toFixed(4),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Summary object for JSON output (no hourly arrays).
 * @param {Config} c
 * @param {ModelRun} run
 * @returns {Record<string, unknown>}
 */
export function resultJson(c, run) {
  const r = run.result;
  const chem = getChemistry(c.battery.chemistry);
  const round = (/** @type {number} */ x, d = 4) => Number(x.toFixed(d));
  return {
    name: c.name,
    summary: run.summary,
    resource: {
      kind: run.resource.kind,
      label: run.resource.label,
      tilt: run.resource.tilt,
      azimuth: run.resource.azimuth,
    },
    panel: { wp: c.panel.wp, charger: c.charger.type },
    battery: {
      chemistry: chem.id,
      cells: c.battery.cells,
      capacityMah: c.battery.capacityMah,
      capacityWh: round(r.limits.capacityWh),
      usableWh: round(r.limits.usableWh),
      socMin: round(r.limits.socMin),
      limitedBy: r.limits.limitedBy,
    },
    budget: {
      WhPerDay: round(run.budget.WhPerDay),
      mAhPerDay: round(run.budget.mAhPerDay, 2),
      averageMa: round(run.budget.averageMa),
      states: run.budget.states.map((s) => ({
        name: s.name,
        hoursPerDay: round(s.hoursPerDay),
        mAhPerDay: round(s.mAhPerDay),
        WhPerDay: round(s.WhPerDay),
      })),
      regulatorWhPerDay: round(run.budget.regulatorWhPerDay),
    },
    totalsWh: Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, round(v, 3)])),
    storedEnergyWh: { start: round(r.eStartWh), end: round(r.eEndWh) },
    downtimeHours: round(r.downtimeHours, 2),
    downtimeEvents: r.downtimeEvents,
    longestOutageHours: round(r.longestOutageHours, 2),
    minSoc: round(r.minSoc),
    minSocDate: dayLabel(r.startMs, Math.floor(r.minSocHour / 24)),
    autonomyDays: round(r.autonomyDays, 2),
    worstDeficit: {
      wh: round(r.deficit.wh),
      from: dayLabel(r.startMs, r.deficit.startDay),
      days: r.deficit.days,
    },
    months: r.months.map((m, i) => ({
      month: MONTHS[i],
      harvestWh: round(m.harvestWh, 2),
      loadWh: round(m.loadWh, 2),
      downtimeHours: round(m.downtimeHours, 2),
    })),
    warnings: run.warnings,
  };
}
