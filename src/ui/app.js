// Browser app: form <-> configuration, runs the model, draws the charts.
// All computation is in src/core; this file only wires the page together.

import { CHEMISTRIES, getChemistry } from "../core/battery.js";
import { ConfigError, defaultConfig, normalizeConfig, validate } from "../core/config.js";
import { EXAMPLES } from "../core/examples.js";
import { REGULATOR_PRESETS } from "../core/load.js";
import { dayLabel, fmt, pct, runModel, toCsv } from "../core/model.js";
import { PvgisFormatError, parsePvgisCsv } from "../core/pvgis.js";
import { size } from "../core/sizer.js";
import { CITIES, CLIMATES, getClimate } from "../core/weather.js";
import { drawHeatmap, drawMonthly, drawPareto, drawStackedBar, drawWeek, palette } from "./draw.js";
import { decodeState, encodeState, importConfigText } from "./state.js";

/** @typedef {import("../core/config.js").Config} Config */
/** @typedef {import("../core/model.js").ModelRun} ModelRun */
/** @typedef {import("../core/sizer.js").SizeResult} SizeResult */
/** @typedef {import("./draw.js").HitTest} HitTest */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (el(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ (el(id));
const canvas = (/** @type {string} */ id) => /** @type {HTMLCanvasElement} */ (el(id));

/** Form field id -> [section, field] for plain numeric settings. */
const FIELDS = /** @type {const} */ ([
  ["lat", "location", "lat"],
  ["lon", "location", "lon"],
  ["tz", "location", "tz"],
  ["seed", "location", "seed"],
  ["cloudScale", "location", "cloudScale"],
  ["wp", "panel", "wp"],
  ["vmp", "panel", "vmp"],
  ["tilt", "panel", "tilt"],
  ["azimuth", "panel", "azimuth"],
  ["tempCoeff", "panel", "tempCoeff"],
  ["noct", "panel", "noct"],
  ["soiling", "panel", "soiling"],
  ["otherLosses", "panel", "otherLosses"],
  ["albedo", "panel", "albedo"],
  ["chargerEff", "charger", "efficiency"],
  ["chargerMa", "charger", "maxCurrentMa"],
  ["cells", "battery", "cells"],
  ["capacity", "battery", "capacityMah"],
  ["dod", "battery", "dod"],
  ["cutoff", "battery", "cutoffV"],
  ["selfDischarge", "battery", "selfDischargePerMonth"],
  ["initialSoc", "battery", "initialSoc"],
  ["warmup", "simulation", "warmupYears"],
  ["restart", "simulation", "restartFraction"],
  ["target", "sizer", "maxDowntimeHours"],
  ["costWp", "sizer", "costPerWp"],
  ["costAh", "sizer", "costPerAh"],
]);

const REG_FIELDS = /** @type {const} */ ([
  ["r-vout", "vout"],
  ["r-iq", "iqUa"],
  ["r-dropout", "dropout"],
  ["r-minvin", "minVin"],
  ["r-nodemin", "nodeMinV"],
]);

const app = {
  /** @type {Config} */
  config: defaultConfig(),
  /** @type {"auto" | "light" | "dark"} */
  theme: "auto",
  /** @type {string | null} */
  example: null,
  /** @type {import("../core/pvgis.js").PvgisData | null} */
  pvgis: null,
  pvgisName: "",
  /** @type {ModelRun | null} */
  run: null,
  /** @type {SizeResult | null} */
  sized: null,
  sizeToken: 0,
  /** @type {Map<HTMLCanvasElement, HitTest>} */
  hits: new Map(),
};

function populateSelects() {
  const ex = select("example");
  ex.append(new Option("Your own setup", ""));
  for (const e of EXAMPLES) ex.append(new Option(e.label, e.id));
  const city = select("city");
  city.append(new Option("Custom coordinates", ""));
  for (const c of CITIES) city.append(new Option(c.label, c.id));
  const climate = select("climate");
  for (const c of CLIMATES) climate.append(new Option(c.label, c.id));
  const chem = select("chemistry");
  for (const c of CHEMISTRIES) chem.append(new Option(c.label, c.id));
  const reg = select("regulator");
  for (const [id, p] of Object.entries(REGULATOR_PRESETS)) reg.append(new Option(p.label, id));
  reg.append(new Option("Custom (edit the parameters)", "custom"));
}

/** @param {Config} c */
function writeForm(c) {
  for (const [id, section, field] of FIELDS) {
    input(id).value = String(
      /** @type {Record<string, number>} */ (/** @type {unknown} */ (c[section]))[field],
    );
  }
  select("climate").value = c.location.climate;
  select("chargerType").value = c.charger.type;
  select("chemistry").value = c.battery.chemistry;
  select("regulator").value = c.regulatorPreset in REGULATOR_PRESETS ? c.regulatorPreset : "custom";
  writeRegulator(c.regulator);
  const match = CITIES.find(
    (x) => x.lat === c.location.lat && x.lon === c.location.lon && x.tz === c.location.tz,
  );
  select("city").value = match ? match.id : "";
  select("example").value = app.example ?? "";
  const ex = EXAMPLES.find((e) => e.id === app.example);
  el("config-note").textContent = ex ? String(ex.config.note ?? "") : "";
  writeLoad(c.load);
  updateClimateNote();
}

/** @param {import("../core/load.js").Regulator} r */
function writeRegulator(r) {
  select("r-type").value = r.type;
  for (const [id, field] of REG_FIELDS) input(id).value = String(r[field]);
  el("r-eff").textContent =
    r.type === "switching"
      ? `Efficiency curve (mA: efficiency): ${r.efficiency.map(([i, e]) => `${i}: ${e}`).join(", ")}. Illustrative; replace it with your converter's datasheet curve via the CLI or the URL parameter reff.`
      : "";
}

/** @param {import("../core/load.js").LoadState[]} states */
function writeLoad(states) {
  const body = el("load-rows");
  body.replaceChildren();
  states.forEach((s, i) => {
    const tr = document.createElement("tr");
    const color = document.createElement("span");
    color.className = "swatch";
    color.style.background = `var(--s${(i % 8) + 1})`;
    tr.innerHTML = `
      <td><div class="hours"></div></td>
      <td><input type="number" step="any" min="0" data-k="mA" aria-label="Current, mA"></td>
      <td><input type="number" step="any" min="0" data-k="every" aria-label="Every, seconds"></td>
      <td><input type="number" step="any" min="0" data-k="duration" aria-label="Duration, seconds"></td>
      <td><div class="hours"><input type="number" step="1" min="0" max="24" data-k="from" aria-label="From hour"><input type="number" step="1" min="0" max="24" data-k="to" aria-label="To hour"></div></td>
      <td><input type="radio" name="base" data-k="base" aria-label="Base state"></td>
      <td><button type="button" data-k="remove" aria-label="Remove state" title="Remove">x</button></td>`;
    const nameCell = /** @type {HTMLElement} */ (tr.querySelector("td div"));
    const name = document.createElement("input");
    name.type = "text";
    name.dataset.k = "name";
    name.setAttribute("aria-label", "State name");
    name.value = s.name;
    nameCell.append(color, name);
    const q = (/** @type {string} */ k) =>
      /** @type {HTMLInputElement} */ (tr.querySelector(`[data-k="${k}"]`));
    q("mA").value = String(s.mA);
    q("every").value = s.base ? "" : String(s.every ?? "");
    q("duration").value = s.base ? "" : String(s.duration ?? "");
    q("from").value = s.base ? "" : String(s.from ?? 0);
    q("to").value = s.base ? "" : String(s.to ?? 24);
    q("base").checked = Boolean(s.base);
    for (const k of ["every", "duration", "from", "to"]) q(k).disabled = Boolean(s.base);
    q("remove").disabled = states.length <= 1;
    q("remove").addEventListener("click", () => {
      const load = readLoad().filter((_, j) => j !== i);
      if (load.length > 0 && !load.some((x) => x.base))
        load[0] = { name: load[0].name, mA: load[0].mA, base: true };
      writeLoad(load);
      changed();
    });
    q("base").addEventListener("change", () => {
      const load = readLoad().map((x, j) => {
        if (j === i) return { name: x.name, mA: x.mA, base: true };
        if (x.base) return { name: x.name, mA: x.mA, every: 600, duration: 1 };
        return x;
      });
      writeLoad(load);
      changed();
    });
    body.append(tr);
  });
}

/** @returns {import("../core/load.js").LoadState[]} */
function readLoad() {
  return [...el("load-rows").querySelectorAll("tr")].map((tr) => {
    const q = (/** @type {string} */ k) =>
      /** @type {HTMLInputElement} */ (tr.querySelector(`[data-k="${k}"]`));
    const n = (/** @type {string} */ k) => (q(k).value.trim() === "" ? NaN : Number(q(k).value));
    /** @type {import("../core/load.js").LoadState} */
    const s = { name: q("name").value.trim() || "state", mA: n("mA") };
    if (q("base").checked) s.base = true;
    else {
      s.every = n("every");
      s.duration = n("duration");
      const from = n("from");
      const to = n("to");
      if (!(from === 0 && to === 24)) {
        s.from = from;
        s.to = to;
      }
    }
    return s;
  });
}

/** @returns {Config} */
function readForm() {
  const c = structuredClone(app.config);
  for (const [id, section, field] of FIELDS) {
    const raw = input(id).value;
    const v = raw.trim() === "" ? NaN : Number(raw);
    /** @type {Record<string, number>} */ (/** @type {unknown} */ (c[section]))[field] = v;
  }
  c.location.climate = select("climate").value;
  c.charger.type = select("chargerType").value === "mppt" ? "mppt" : "linear";
  c.battery.chemistry = select("chemistry").value;
  const regId = select("regulator").value;
  c.regulatorPreset = regId;
  const type = select("r-type").value;
  c.regulator.type = type === "ldo" || type === "switching" ? type : "none";
  if (c.regulator.type === "switching" && c.regulator.efficiency.length === 0)
    c.regulator.efficiency = structuredClone(REGULATOR_PRESETS.buck.regulator.efficiency);
  for (const [id, field] of REG_FIELDS) {
    const raw = input(id).value;
    c.regulator[field] = raw.trim() === "" ? NaN : Number(raw);
  }
  c.load = readLoad();
  for (const [i, s] of c.load.entries()) {
    for (const k of /** @type {const} */ (["mA", "every", "duration", "from", "to"])) {
      const v = s[k];
      if (v !== undefined && !(Number.isFinite(v) && v >= 0))
        throw new ConfigError(`load state ${i + 1} (${s.name}): ${k} must be a number >= 0`);
    }
    if (!s.base && !((s.every ?? 0) > 0))
      throw new ConfigError(`load state ${i + 1} (${s.name}): "every" must be > 0`);
  }
  for (const [id, section, field] of FIELDS)
    if (
      !Number.isFinite(
        /** @type {Record<string, number>} */ (/** @type {unknown} */ (c[section]))[field],
      )
    )
      throw new ConfigError(`${id} must be a number`);
  validate(c);
  return c;
}

function updateClimateNote() {
  const c = getClimate(select("climate").value);
  el("climate-note").textContent = app.pvgis
    ? "The synthetic climate is not used while a PVGIS file is loaded."
    : `${c.source}. Day-to-day clouds come from the seed; change it to see another possible year.`;
}

let timer = 0;
function changed() {
  window.clearTimeout(timer);
  timer = window.setTimeout(recompute, 120);
}

function recompute() {
  const status = el("status");
  const error = el("error");
  let c;
  try {
    c = readForm();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    error.hidden = false;
    error.textContent = `Not simulated: ${e.message}`;
    status.textContent = "invalid input";
    return;
  }
  error.hidden = true;
  app.config = c;
  const run = runModel(c, app.pvgis);
  app.run = run;
  render(run);
  history.replaceState(
    null,
    "",
    `?${encodeState({ config: c, theme: app.theme, example: app.example, ignored: [] })}`,
  );
  status.textContent = "sizing";
  el("sizer-status").textContent = "Simulating every panel and battery combination...";
  const token = ++app.sizeToken;
  window.setTimeout(() => {
    if (token !== app.sizeToken) return;
    const t0 = performance.now();
    app.sized = size(c, run.prepared);
    renderSizer(app.sized, performance.now() - t0);
    status.textContent = "ready";
  }, 0);
}

/**
 * @param {string} label
 * @param {string} value
 * @param {string} [title]
 * @returns {HTMLElement}
 */
function tile(label, value, title) {
  const d = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  if (title) d.title = title;
  d.append(dt, dd);
  return d;
}

/** @param {ModelRun} run */
function render(run) {
  const r = run.result;
  const summary = el("summary");
  summary.textContent = run.summary;
  summary.classList.toggle("bad", r.downtimeHours >= 0.05);
  const tiles = el("tiles");
  const reason = {
    dod: "depth of discharge",
    cutoff: "cut-off voltage",
    regulator: "regulator minimum input",
  };
  tiles.replaceChildren(
    tile(
      "Daily load",
      `${fmt(run.budget.WhPerDay * 1000)} mWh`,
      `${fmt(run.budget.mAhPerDay)} mAh/day at ${fmt(r.limits.vnom)} V`,
    ),
    tile("Average current", `${fmt(run.budget.averageMa)} mA`),
    tile(
      "Usable battery",
      `${fmt(r.limits.usableWh)} Wh`,
      `floor ${pct(r.limits.socMin)} set by the ${reason[r.limits.limitedBy]}`,
    ),
    tile("Autonomy from full", `${fmt(r.autonomyDays)} days`),
    tile(
      "Downtime",
      `${fmt(r.downtimeHours)} h`,
      `${r.downtimeEvents} outage(s), longest ${fmt(r.longestOutageHours)} h`,
    ),
    tile("Lowest charge", pct(r.minSoc), dayLabel(r.startMs, Math.floor(r.minSocHour / 24))),
    tile(
      "Worst deficit",
      `${fmt(r.deficit.wh)} Wh`,
      r.deficit.days > 0
        ? `${r.deficit.days} day(s) from ${dayLabel(r.startMs, r.deficit.startDay)}`
        : "harvest covered the load every day",
    ),
    tile(
      "Stored from panel",
      `${fmt(r.totals.stored)} Wh`,
      `charger offered ${fmt(r.totals.offered)} Wh`,
    ),
    tile(
      "Clipped",
      pct(r.totals.offered > 0 ? r.totals.clipped / r.totals.offered : 0),
      "offered energy the battery could not take (full or rate-limited)",
    ),
  );
  const warnings = el("warnings");
  warnings.replaceChildren(
    ...run.warnings.map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
  el("week-label").textContent =
    `(${dayLabel(r.startMs, r.worstWeekStartDay)} - ${dayLabel(r.startMs, Math.min(r.days - 1, r.worstWeekStartDay + 6))})`;
  drawAll();
}

function drawAll() {
  const run = app.run;
  if (!run) return;
  const r = run.result;
  const p = palette();
  const segments = run.budget.states.map((s, i) => ({
    label: s.name,
    value: s.WhPerDay * 1000,
    color: p.series[i % 8],
  }));
  segments.push({
    label: "Regulator loss and quiescent current",
    value: run.budget.regulatorWhPerDay * 1000,
    color: p.neutral,
  });
  app.hits.set(canvas("c-budget"), drawStackedBar(canvas("c-budget"), segments));
  const legend = el("budget-legend");
  legend.replaceChildren(
    ...segments.map((s, i) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background =
        i < run.budget.states.length ? `var(--s${(i % 8) + 1})` : "var(--neutral)";
      li.append(sw, `${s.label}: ${fmt(s.value)} mWh`);
      return li;
    }),
  );
  app.hits.set(canvas("c-heat"), drawHeatmap(canvas("c-heat"), r));
  app.hits.set(canvas("c-month"), drawMonthly(canvas("c-month"), r));
  app.hits.set(canvas("c-week-soc"), drawWeek(canvas("c-week-soc"), r, r.worstWeekStartDay, "soc"));
  app.hits.set(
    canvas("c-week-flow"),
    drawWeek(canvas("c-week-flow"), r, r.worstWeekStartDay, "flow"),
  );
  if (app.sized)
    app.hits.set(
      canvas("c-pareto"),
      drawPareto(canvas("c-pareto"), app.sized, {
        wp: app.config.panel.wp,
        mah: app.config.battery.capacityMah,
      }),
    );
}

/**
 * @param {SizeResult} s
 * @param {number} ms
 */
function renderSizer(s, ms) {
  el("sizer-status").textContent =
    `${s.runs} year-long simulations in ${fmt(ms)} ms. Grid ${fmt(s.panelWp[0])}-${fmt(s.panelWp[s.panelWp.length - 1])} Wp by ${fmt(s.batteryMah[0])}-${fmt(s.batteryMah[s.batteryMah.length - 1])} mAh, chosen from the load. Target: at most ${fmt(s.target)} h of downtime.`;
  const best = el("best");
  const apply = /** @type {HTMLButtonElement} */ (el("btn-apply-best"));
  if (s.best) {
    const front = s.frontier.map((f) => `${fmt(f.wp)} Wp + ${fmt(f.capacityMah)} mAh`).join("; ");
    best.textContent = `Lowest cost: ${fmt(s.best.wp)} Wp + ${fmt(s.best.capacityMah)} mAh. Frontier: ${front}.`;
    apply.hidden = false;
  } else {
    best.textContent =
      "No combination in the grid meets the target. Reduce the load, allow some downtime or use a PVGIS file for a sunnier site.";
    apply.hidden = true;
  }
  drawAll();
}

/**
 * @param {MouseEvent} ev
 * @param {HTMLCanvasElement} cv
 */
function hover(ev, cv) {
  const tip = el("tooltip");
  const hit = app.hits.get(cv);
  const rect = cv.getBoundingClientRect();
  const res = hit ? hit(ev.clientX - rect.left, ev.clientY - rect.top) : null;
  if (!res) {
    tip.hidden = true;
    return;
  }
  tip.textContent = res.text;
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 12);
  const y =
    ev.clientY + 16 + tip.offsetHeight > window.innerHeight
      ? ev.clientY - tip.offsetHeight - 8
      : ev.clientY + 16;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${y}px`;
}

function applyTheme() {
  if (app.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = app.theme;
  el("btn-theme").textContent = `Theme: ${app.theme}`;
}

function bind() {
  for (const [id] of FIELDS) input(id).addEventListener("input", changed);
  for (const [id] of REG_FIELDS)
    input(id).addEventListener("input", () => {
      select("regulator").value = "custom";
      changed();
    });
  el("load-rows").addEventListener("input", changed);
  el("btn-add-state").addEventListener("click", () => {
    const load = readLoad();
    load.push({ name: `state ${load.length + 1}`, mA: 10, every: 3600, duration: 1 });
    writeLoad(load);
    changed();
  });
  for (const id of ["chargerType", "climate"])
    select(id).addEventListener("change", () => {
      updateClimateNote();
      changed();
    });
  select("r-type").addEventListener("change", () => {
    select("regulator").value = "custom";
    changed();
  });
  select("chemistry").addEventListener("change", () => {
    const chem = getChemistry(select("chemistry").value);
    const cells = Number(input("cells").value) || 1;
    input("dod").value = String(chem.defaultDod);
    input("cutoff").value = String(Number((chem.defaultCutoffCell * cells).toFixed(3)));
    input("selfDischarge").value = String(chem.selfDischargePerMonth);
    changed();
  });
  select("regulator").addEventListener("change", () => {
    const id = select("regulator").value;
    if (id in REGULATOR_PRESETS) writeRegulator(structuredClone(REGULATOR_PRESETS[id].regulator));
    app.config.regulator =
      id in REGULATOR_PRESETS
        ? structuredClone(REGULATOR_PRESETS[id].regulator)
        : app.config.regulator;
    changed();
  });
  select("city").addEventListener("change", () => {
    const city = CITIES.find((x) => x.id === select("city").value);
    if (!city) return;
    input("lat").value = String(city.lat);
    input("lon").value = String(city.lon);
    input("tz").value = String(city.tz);
    select("climate").value = city.climate;
    updateClimateNote();
    changed();
  });
  select("example").addEventListener("change", () => {
    const ex = EXAMPLES.find((x) => x.id === select("example").value);
    if (!ex) return;
    app.example = ex.id;
    app.config = normalizeConfig(ex.config);
    writeForm(app.config);
    recompute();
  });
  input("config-file").addEventListener("change", async () => {
    const file = input("config-file").files?.[0];
    if (file) await importConfigFile(file);
  });
  input("pvgis-file").addEventListener("change", async () => {
    const file = input("pvgis-file").files?.[0];
    if (file) await loadPvgisFile(file);
  });
  // Drop a configuration JSON or a PVGIS CSV anywhere on the page.
  document.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
  });
  document.addEventListener("drop", async (ev) => {
    const file = ev.dataTransfer?.files[0];
    if (!file) return;
    ev.preventDefault();
    if (/\.csv$/i.test(file.name) || file.type === "text/csv") await loadPvgisFile(file);
    else await importConfigFile(file);
  });
  el("btn-synthetic").addEventListener("click", () => {
    app.pvgis = null;
    input("pvgis-file").value = "";
    el("pvgis-status").textContent = "";
    el("btn-synthetic").hidden = true;
    updateClimateNote();
    recompute();
  });
  el("btn-link").addEventListener("click", async () => {
    const btn = el("btn-link");
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = "Link copied";
    } catch {
      btn.textContent = "Copy the address bar";
    }
    window.setTimeout(() => (btn.textContent = "Copy link"), 1500);
  });
  el("btn-csv").addEventListener("click", () => {
    if (!app.run) return;
    const blob = new Blob([toCsv(app.run.resource, app.run.result)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "solar-node-sizer-hourly.csv";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el("btn-theme").addEventListener("click", () => {
    app.theme = app.theme === "auto" ? "light" : app.theme === "light" ? "dark" : "auto";
    applyTheme();
    drawAll();
    if (app.config)
      history.replaceState(
        null,
        "",
        `?${encodeState({ config: app.config, theme: app.theme, example: app.example, ignored: [] })}`,
      );
  });
  el("btn-apply-best").addEventListener("click", () => {
    if (!app.sized?.best) return;
    input("wp").value = String(app.sized.best.wp);
    input("capacity").value = String(app.sized.best.capacityMah);
    recompute();
  });
  for (const id of ["c-budget", "c-heat", "c-month", "c-week-soc", "c-week-flow", "c-pareto"]) {
    const cv = canvas(id);
    cv.addEventListener("pointermove", (ev) => hover(ev, cv));
    cv.addEventListener("pointerleave", () => (el("tooltip").hidden = true));
  }
  let lastWidth = 0;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w !== lastWidth) {
      lastWidth = w;
      drawAll();
    }
  }).observe(el("c-heat"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}

/**
 * Read a PVGIS CSV the user picked or dropped.
 * @param {File} file
 */
async function loadPvgisFile(file) {
  const statusEl = el("pvgis-status");
  try {
    app.pvgis = parsePvgisCsv(await file.text());
    app.pvgisName = file.name;
    const m = app.pvgis.meta;
    statusEl.textContent = `Using ${file.name}: ${app.pvgis.times.length} hours${m.lat !== null ? ` at ${m.lat}, ${m.lon}` : ""}${app.pvgis.kind === "series" ? `, tilt ${m.slope ?? "?"} deg and azimuth ${m.azimuth ?? "?"} deg from the file` : " (TMY, transposed to the panel settings)"}. The file stays in this browser and is not part of the shared link.`;
    el("btn-synthetic").hidden = false;
  } catch (e) {
    if (!(e instanceof PvgisFormatError)) throw e;
    app.pvgis = null;
    statusEl.textContent = `Could not read ${file.name}: ${e.message}`;
  }
  updateClimateNote();
  recompute();
}

/**
 * Apply a configuration JSON the user picked or dropped: a saved
 * configuration or the export of embedded-power-profiler. Sections in the
 * file replace the current ones; a load profile on its own changes only the
 * load.
 * @param {File} file
 */
async function importConfigFile(file) {
  const statusEl = el("config-status");
  let result;
  try {
    result = importConfigText(await file.text(), readFormOrCurrent());
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    statusEl.textContent = `Could not import ${file.name}: ${e.message}`;
    return;
  }
  app.example = null;
  app.config = result.config;
  writeForm(app.config);
  el("config-note").textContent = app.config.note;
  const n = app.config.load.length;
  statusEl.textContent = result.loadOnly
    ? `Imported ${file.name}: load profile with ${n} states; the other settings are unchanged.`
    : `Imported ${file.name}: ${result.replaced.join(", ")} (${n} load states).`;
  recompute();
}

/** The form's configuration, or the last valid one if the form is invalid. */
function readFormOrCurrent() {
  try {
    return readForm();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return app.config;
  }
}

function init() {
  populateSelects();
  const st = decodeState(location.search.slice(1));
  app.config = st.config;
  app.theme = st.theme;
  app.example = EXAMPLES.some((e) => e.id === st.example) ? st.example : null;
  if (!location.search) app.example = EXAMPLES[0].id;
  applyTheme();
  writeForm(app.config);
  bind();
  recompute();
  if (st.ignored.length > 0) {
    const li = document.createElement("li");
    li.textContent = `Ignored invalid link parameter(s): ${st.ignored.join(", ")}.`;
    el("warnings").append(li);
  }
}

init();
