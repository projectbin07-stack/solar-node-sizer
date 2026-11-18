// Parser for the CSV files produced by PVGIS (EU Joint Research Centre,
// https://re.jrc.ec.europa.eu/pvg_tools/en/), which the user downloads
// themselves. Two kinds are understood:
//
//  - "Hourly data" (API: seriescalc): metadata lines, "Slope: 15 deg.",
//    "Azimuth: 0 deg.", then a header such as
//      time,G(i),H_sun,T2m,WS10m,Int
//      time,P,Gb(i),Gd(i),Gr(i),H_sun,T2m,WS10m,Int      (with components)
//    Irradiance is already on the inclined plane; tilt and azimuth come from
//    the file. PVGIS azimuth is 0 = south, 90 = west, -90 = east.
//  - "TMY" (API: tmy): header
//      time(UTC),T2m,RH,G(h),Gb(n),Gd(h),IR(h),WS10m,WD10m,SP
//    Horizontal global, normal beam and horizontal diffuse; this tool
//    transposes them to the panel plane itself.
//
// Times are UTC, "YYYYMMDD:HHMM". The legend and copyright lines after the
// data are ignored. No network access: the text is passed in.

/**
 * @typedef {object} PvgisMeta
 * @property {number | null} lat
 * @property {number | null} lon
 * @property {number | null} elevation metres
 * @property {string | null} database e.g. PVGIS-ERA5
 * @property {number | null} slope tilt in degrees (series only)
 * @property {number | null} azimuth panel azimuth in this tool's convention,
 *   degrees clockwise from north (180 = south); converted from PVGIS (0 = south)
 * @property {number} timeOffsetH TMY "Irradiance Time Offset" in hours (0 if absent)
 */

/**
 * @typedef {object} PvgisData
 * @property {"series" | "tmy"} kind
 * @property {PvgisMeta} meta
 * @property {number[]} times UTC milliseconds of each row
 * @property {Float64Array} tAmb air temperature at 2 m, degC
 * @property {Float64Array | null} poa plane-of-array global irradiance (series)
 * @property {Float64Array | null} ghi global horizontal (TMY)
 * @property {Float64Array | null} dni beam normal (TMY)
 * @property {Float64Array | null} dhi diffuse horizontal (TMY)
 * @property {string[]} warnings
 */

export class PvgisFormatError extends Error {}

/**
 * Parse "YYYYMMDD:HHMM" as UTC milliseconds.
 * @param {string} s
 * @returns {number}
 */
export function parsePvgisTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2}):(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return NaN;
  return Date.UTC(y, mo - 1, d, h, mi);
}

/**
 * Read the first number in a string.
 * @param {string} s
 * @returns {number | null}
 */
function firstNumber(s) {
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

/**
 * Parse a PVGIS hourly-series or TMY CSV.
 * @param {string} text
 * @returns {PvgisData}
 */
export function parsePvgisCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  /** @type {PvgisMeta} */
  const meta = {
    lat: null,
    lon: null,
    elevation: null,
    database: null,
    slope: null,
    azimuth: null,
    timeOffsetH: 0,
  };
  /** @type {string[]} */
  const warnings = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^time(\(UTC\))?\s*,/i.test(line)) {
      headerIdx = i;
      break;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2];
    if (key.startsWith("latitude")) meta.lat = firstNumber(value);
    else if (key.startsWith("longitude")) meta.lon = firstNumber(value);
    else if (key.startsWith("elevation")) meta.elevation = firstNumber(value);
    else if (key.startsWith("radiation database")) meta.database = value.trim() || null;
    else if (key.startsWith("slope")) meta.slope = firstNumber(value);
    else if (key.startsWith("azimuth")) {
      const a = firstNumber(value);
      meta.azimuth = a === null ? null : (((a + 180) % 360) + 360) % 360;
    } else if (key.startsWith("irradiance time offset")) meta.timeOffsetH = firstNumber(value) ?? 0;
  }
  if (headerIdx < 0)
    throw new PvgisFormatError(
      "No data header found. Expected a line starting with 'time,' (PVGIS hourly data) or 'time(UTC),' (PVGIS TMY), from a CSV download.",
    );
  const cols = lines[headerIdx].split(",").map((c) => c.trim());
  const col = (/** @type {string} */ name) => cols.indexOf(name);
  const iT = col("T2m");
  const iGi = col("G(i)");
  const iGb = col("Gb(i)");
  const iGd = col("Gd(i)");
  const iGr = col("Gr(i)");
  const iGh = col("G(h)");
  const iBn = col("Gb(n)");
  const iDh = col("Gd(h)");
  /** @type {"series" | "tmy"} */
  let kind;
  if (iGi >= 0 || (iGb >= 0 && iGd >= 0)) kind = "series";
  else if (iGh >= 0 && iBn >= 0 && iDh >= 0) kind = "tmy";
  else
    throw new PvgisFormatError(
      `Unrecognised columns: ${cols.join(", ")}. Expected G(i) or Gb(i)/Gd(i)/Gr(i) (hourly data), or G(h)/Gb(n)/Gd(h) (TMY).`,
    );
  if (iT < 0) warnings.push("No T2m column: 25 degC air temperature assumed.");

  /** @type {number[]} */
  const times = [];
  /** @type {number[][]} */
  const rows = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {
      if (rows.length > 0) break; // the legend follows the first blank line
      continue;
    }
    const parts = line.split(",");
    const t = parsePvgisTime(parts[0]);
    if (!Number.isFinite(t)) {
      if (rows.length > 0) break;
      skipped++;
      continue;
    }
    const values = parts.map((p) => Number(p));
    times.push(t);
    rows.push(values);
  }
  if (rows.length < 24)
    throw new PvgisFormatError(`Only ${rows.length} data rows; need at least one day.`);
  if (skipped > 0)
    warnings.push(`${skipped} line(s) before the data could not be read and were skipped.`);
  if (kind === "tmy") {
    // A TMY stitches months from different years, so the timestamps jump at
    // month boundaries. Re-time it as one consecutive non-leap year.
    const first = new Date(times[0]);
    const start = Date.UTC(2025, 0, 1, 0, first.getUTCMinutes());
    for (let i = 0; i < times.length; i++) times[i] = start + i * 3600000;
    if (times.length !== 8760) warnings.push(`TMY has ${times.length} rows; 8760 expected.`);
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] !== 3600000)
      throw new PvgisFormatError(
        `Rows must be consecutive hours; row ${i + 1} is ${(times[i] - times[i - 1]) / 60000} min after the previous one.`,
      );
  }
  const n = rows.length;
  let bad = 0;
  /**
   * @param {number} idx
   * @param {number} fallback
   * @returns {Float64Array}
   */
  const column = (idx, fallback) => {
    const out = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      const v = idx >= 0 ? rows[r][idx] : fallback;
      if (Number.isFinite(v)) out[r] = v;
      else {
        out[r] = fallback;
        bad++;
      }
    }
    return out;
  };
  const tAmb = column(iT, 25);
  /** @type {Float64Array | null} */
  let poa = null;
  /** @type {Float64Array | null} */
  let ghi = null;
  /** @type {Float64Array | null} */
  let dni = null;
  /** @type {Float64Array | null} */
  let dhi = null;
  if (kind === "series") {
    if (iGi >= 0) poa = column(iGi, 0);
    else {
      const b = column(iGb, 0);
      const d = column(iGd, 0);
      const g = column(iGr, 0);
      poa = new Float64Array(n);
      for (let r = 0; r < n; r++) poa[r] = b[r] + d[r] + g[r];
    }
    for (let r = 0; r < n; r++) poa[r] = Math.max(0, poa[r]);
    if (meta.slope === null)
      warnings.push("No 'Slope:' line; the panel tilt from the settings is shown instead.");
    if (meta.azimuth === null)
      warnings.push("No 'Azimuth:' line; the panel azimuth from the settings is shown instead.");
  } else {
    ghi = column(iGh, 0);
    dni = column(iBn, 0);
    dhi = column(iDh, 0);
    for (let r = 0; r < n; r++) {
      ghi[r] = Math.max(0, ghi[r]);
      dni[r] = Math.max(0, dni[r]);
      dhi[r] = Math.max(0, dhi[r]);
    }
  }
  if (bad > 0)
    warnings.push(`${bad} unreadable value(s) replaced (irradiance 0, temperature 25 degC).`);
  return { kind, meta, times, tAmb, poa, ghi, dni, dhi, warnings };
}
