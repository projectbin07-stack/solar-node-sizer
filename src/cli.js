// Headless command-line interface. Runs the same model code as the browser
// app, without a DOM, for scripting and reproducible numbers.

import { parseArgs } from "node:util";
import { CHEMISTRIES, getChemistry } from "./core/battery.js";
import { ConfigError, normalizeConfig } from "./core/config.js";
import { REGULATOR_PRESETS } from "./core/load.js";
import { MONTHS, dayLabel, fmt, pct, resultJson, runModel, toCsv } from "./core/model.js";
import { PvgisFormatError, parsePvgisCsv } from "./core/pvgis.js";
import { size } from "./core/sizer.js";
import { CITIES, CLIMATES } from "./core/weather.js";

export const VERSION = "0.1.0";

/**
 * Everything the CLI touches outside itself, so tests can run it in memory.
 * @typedef {object} CliIo
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {(path: string) => string} readFile
 * @property {(path: string, data: string) => void} writeFile
 */

const HELP = `solar-node-sizer ${VERSION}: solar panel and battery sizing for embedded nodes

Usage:
  solar-node-sizer simulate <config.json> [options]
  solar-node-sizer size <config.json> [options]
  solar-node-sizer presets [--json]
  solar-node-sizer --help | --version

simulate runs the hour-by-hour year for the panel and battery in the
configuration and prints the energy budget, the energy flows and whether
the node stays up. size simulates every combination of the sizer's panel
and battery grids and prints the downtime table, the Pareto frontier and
the lowest-cost combination that meets the downtime target.

Options:
  --pvgis <file.csv>   use a PVGIS hourly-data or TMY CSV you downloaded
                       instead of the synthetic weather
  --seed <n>           synthetic weather seed (overrides location.seed)
  --wp <W>             panel size (overrides panel.wp)
  --mah <mAh>          battery capacity (overrides battery.capacityMah)
  --json               print JSON instead of text
  --csv <file>         (simulate) write the hourly results to a CSV file

Results are model estimates. The synthetic weather is illustrative; see
docs/models.md for the equations and their limits.
`;

class UsageError extends Error {}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {number | undefined}
 */
function num(value, name) {
  if (value === undefined) return undefined;
  const v = Number(value);
  if (value.trim() === "" || !Number.isFinite(v))
    throw new UsageError(`--${name} must be a number`);
  return v;
}

/**
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number} exit code
 */
export function main(argv, io) {
  try {
    return run(argv, io);
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError || e instanceof PvgisFormatError) {
      io.err(`error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof SyntaxError) {
      io.err(`error: configuration is not valid JSON: ${e.message}\n`);
      return 2;
    }
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err && err.code === "ENOENT") {
      io.err(`error: file not found: ${err.path}\n`);
      return 2;
    }
    throw e;
  }
}

/**
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number}
 */
function run(argv, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
        pvgis: { type: "string" },
        seed: { type: "string" },
        wp: { type: "string" },
        mah: { type: "string" },
        csv: { type: "string" },
      },
    });
  } catch (e) {
    throw new UsageError(/** @type {Error} */ (e).message);
  }
  const { values: o, positionals } = parsed;
  if (o.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const [command, file, ...extra] = positionals;
  if (o.help || command === undefined) {
    io.out(HELP);
    return 0;
  }
  if (command === "presets") {
    io.out(presets(Boolean(o.json)));
    return 0;
  }
  if (command !== "simulate" && command !== "size")
    throw new UsageError(`unknown command '${command}' (try --help)`);
  if (file === undefined) throw new UsageError(`${command} needs a configuration file`);
  if (extra.length > 0) throw new UsageError(`unexpected argument '${extra[0]}'`);
  if (o.csv !== undefined && command !== "simulate")
    throw new UsageError("--csv only applies to simulate");

  const raw = JSON.parse(io.readFile(file));
  const seed = num(o.seed, "seed");
  const wp = num(o.wp, "wp");
  const mah = num(o.mah, "mah");
  if (seed !== undefined) raw.location = { ...raw.location, seed };
  if (wp !== undefined) raw.panel = { ...raw.panel, wp };
  if (mah !== undefined) raw.battery = { ...raw.battery, capacityMah: mah };
  const config = normalizeConfig(raw);
  const pvgis = o.pvgis !== undefined ? parsePvgisCsv(io.readFile(o.pvgis)) : null;
  const model = runModel(config, pvgis);

  if (command === "simulate") {
    if (o.csv !== undefined) io.writeFile(o.csv, toCsv(model.resource, model.result));
    io.out(
      o.json
        ? JSON.stringify(resultJson(config, model), null, 2) + "\n"
        : simulateText(config, model),
    );
    return 0;
  }
  const s = size(config, model.prepared);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          name: config.name,
          resource: model.resource.label,
          targetDowntimeHours: s.target,
          panelWp: s.panelWp,
          batteryMah: s.batteryMah,
          downtimeHours: s.downtime,
          peakLimited: s.peakLimited,
          minMahForPeak: Number(s.minMahForPeak.toFixed(1)),
          frontier: s.frontier.map((p) => ({ ...p, minSoc: Number(p.minSoc.toFixed(4)) })),
          best: s.best ? { ...s.best, minSoc: Number(s.best.minSoc.toFixed(4)) } : null,
          runs: s.runs,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  io.out(sizeText(config, model, s));
  return 0;
}

/**
 * @param {boolean} json
 * @returns {string}
 */
function presets(json) {
  if (json)
    return (
      JSON.stringify(
        {
          cities: CITIES,
          climates: CLIMATES.map((c) => ({ id: c.id, label: c.label, source: c.source })),
          chemistries: CHEMISTRIES.map((c) => ({ id: c.id, label: c.label })),
          regulators: Object.entries(REGULATOR_PRESETS).map(([id, p]) => ({ id, label: p.label })),
        },
        null,
        2,
      ) + "\n"
    );
  const lines = ["Example cities (location.lat/lon/tz/climate):"];
  for (const c of CITIES)
    lines.push(
      `  ${c.id.padEnd(10)} ${c.label} (${c.lat}, ${c.lon}, UTC${c.tz >= 0 ? "+" : ""}${c.tz})`,
    );
  lines.push("Synthetic climates (location.climate; illustrative):");
  for (const c of CLIMATES) lines.push(`  ${c.id.padEnd(10)} ${c.label}`);
  lines.push("Battery chemistries (battery.chemistry):");
  for (const c of CHEMISTRIES) lines.push(`  ${c.id.padEnd(10)} ${c.label}`);
  lines.push("Regulators (regulatorPreset):");
  for (const [id, p] of Object.entries(REGULATOR_PRESETS))
    lines.push(`  ${id.padEnd(12)} ${p.label}`);
  return lines.join("\n") + "\n";
}

/**
 * @param {import("./core/config.js").Config} c
 * @param {import("./core/model.js").ModelRun} m
 * @returns {string}
 */
function simulateText(c, m) {
  const r = m.result;
  const chem = getChemistry(c.battery.chemistry);
  const t = r.totals;
  const lines = [
    `config       ${c.name}`,
    `weather      ${m.resource.label}`,
    `panel        ${c.panel.wp} Wp, tilt ${m.resource.tilt} deg, azimuth ${m.resource.azimuth} deg, ${c.charger.type} charger, limit ${c.charger.maxCurrentMa} mA`,
    `battery      ${chem.label}, ${c.battery.cells}S ${c.battery.capacityMah} mAh = ${fmt(r.limits.capacityWh)} Wh, usable ${fmt(r.limits.usableWh)} Wh (floor ${pct(r.limits.socMin)}, set by ${r.limits.limitedBy})`,
    `regulator    ${c.regulatorPreset in REGULATOR_PRESETS ? REGULATOR_PRESETS[c.regulatorPreset].label : `custom ${c.regulator.type}`}`,
    "daily budget (at the battery, nominal voltage)",
  ];
  for (const s of m.budget.states)
    lines.push(
      `  ${s.name.padEnd(24)} ${fmt(s.hoursPerDay).padStart(6)} h  ${fmt(s.mAhPerDay).padStart(7)} mAh  ${fmt(s.WhPerDay * 1000).padStart(7)} mWh`,
    );
  lines.push(
    `  ${"regulator overhead".padEnd(24)} ${"".padStart(6)}    ${"".padStart(7)}      ${fmt(m.budget.regulatorWhPerDay * 1000).padStart(7)} mWh`,
  );
  lines.push(
    `  total                    ${fmt(m.budget.WhPerDay * 1000)} mWh/day = ${fmt(m.budget.mAhPerDay)} mAh/day, average ${fmt(m.budget.averageMa)} mA`,
  );
  lines.push(`year (${r.days} days)`);
  lines.push(`  panel output           ${fmt(t.pv)} Wh`);
  lines.push(`  charger output         ${fmt(t.offered)} Wh`);
  lines.push(`  stored in battery      ${fmt(t.stored)} Wh (charge loss ${fmt(t.chargeLoss)} Wh)`);
  lines.push(`  clipped                ${fmt(t.clipped)} Wh (battery full or charge limits)`);
  lines.push(`  delivered to node      ${fmt(t.load)} Wh (unserved ${fmt(t.unserved)} Wh)`);
  lines.push(`  self-discharge         ${fmt(t.selfDischarge)} Wh`);
  lines.push(`  stored energy          ${fmt(r.eStartWh)} -> ${fmt(r.eEndWh)} Wh`);
  lines.push(
    `  downtime               ${fmt(r.downtimeHours)} h in ${r.downtimeEvents} outage(s), longest ${fmt(r.longestOutageHours)} h`,
  );
  lines.push(
    `  lowest charge          ${pct(r.minSoc)} on ${dayLabel(r.startMs, Math.floor(r.minSocHour / 24))}`,
  );
  lines.push(
    `  worst deficit          ${fmt(r.deficit.wh)} Wh over ${r.deficit.days} day(s) from ${dayLabel(r.startMs, r.deficit.startDay)}`,
  );
  lines.push(`  autonomy               ${fmt(r.autonomyDays)} days from full`);
  lines.push("month   stored Wh   load Wh   down h");
  r.months.forEach((mo, i) => {
    if (mo.days === 0) return;
    lines.push(
      `  ${MONTHS[i]}   ${fmt(mo.harvestWh).padStart(9)} ${fmt(mo.loadWh).padStart(9)} ${fmt(mo.downtimeHours).padStart(8)}`,
    );
  });
  for (const w of m.warnings) lines.push(`note: ${w}`);
  lines.push(`result: ${m.summary}`);
  return lines.join("\n") + "\n";
}

/**
 * @param {import("./core/config.js").Config} c
 * @param {import("./core/model.js").ModelRun} m
 * @param {import("./core/sizer.js").SizeResult} s
 * @returns {string}
 */
function sizeText(c, m, s) {
  const lines = [
    `config       ${c.name}`,
    `weather      ${m.resource.label}`,
    `target       downtime <= ${s.target} h per year (${s.runs} simulations)`,
    "downtime hours (rows: panel Wp, columns: battery mAh)",
    `  ${"Wp \\ mAh".padStart(8)} ${s.batteryMah.map((b) => String(b).padStart(6)).join(" ")}`,
  ];
  s.panelWp.forEach((wp, i) => {
    const row = s.downtime[i].map((d, j) =>
      (s.peakLimited[j]
        ? "peak"
        : d <= s.target
          ? d === 0
            ? "ok"
            : fmt(d) + "*"
          : fmt(d)
      ).padStart(6),
    );
    lines.push(`  ${String(wp).padStart(8)} ${row.join(" ")}`);
  });
  lines.push(
    `  ok = no downtime; peak = below ${fmt(s.minMahForPeak)} mAh the battery cannot deliver the peak current`,
  );
  lines.push("frontier (smallest battery for each panel size that meets the target)");
  if (s.frontier.length === 0) lines.push("  none: no combination in the grid meets the target");
  for (const p of s.frontier)
    lines.push(
      `  ${String(p.wp).padStart(5)} Wp + ${String(p.capacityMah).padStart(6)} mAh   lowest charge ${pct(p.minSoc)}`,
    );
  if (s.best)
    lines.push(
      `best         ${s.best.wp} Wp + ${s.best.capacityMah} mAh (relative cost ${fmt(s.best.cost)} with ${c.sizer.costPerWp}/Wp and ${c.sizer.costPerAh}/Ah)`,
    );
  return lines.join("\n") + "\n";
}
