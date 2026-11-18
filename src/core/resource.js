// Hourly solar resource on the panel plane, in local standard time:
// either generated (solar geometry + clear sky + synthetic clouds) or taken
// from a PVGIS file the user downloaded.

import { dayOfYear, haurwitzGhi, sunPosition, transpose, transposeComponents } from "./solar.js";
import { airTemperature, dailyClearIndex, getClimate } from "./weather.js";

/** @typedef {import("./pvgis.js").PvgisData} PvgisData */

/**
 * @typedef {object} Resource
 * @property {"synthetic" | "pvgis-series" | "pvgis-tmy"} kind
 * @property {string} label
 * @property {number} startMs local wall-clock time of hour 0 expressed as a UTC
 *   timestamp (so new Date(startMs).getUTC*() reads the local date)
 * @property {number} hours
 * @property {Float64Array} poa mean plane-of-array irradiance of each hour, W/m^2
 * @property {Float64Array} tAmb mean air temperature of each hour, degC
 * @property {number} tilt degrees, the geometry actually used
 * @property {number} azimuth degrees clockwise from north
 * @property {string[]} notes
 */

/**
 * @typedef {object} SyntheticOptions
 * @property {number} lat
 * @property {number} lon
 * @property {number} tz hours east of UTC
 * @property {number} tilt
 * @property {number} azimuth
 * @property {number} albedo
 * @property {string} climate preset id
 * @property {number} seed
 * @property {number} cloudScale multiplies the daily clear-sky index
 */

const YEAR = 2025; // a non-leap year; the sun's path changes negligibly between years
const SUBSTEPS = 4;

/**
 * Generate a 365-day synthetic year.
 * @param {SyntheticOptions} o
 * @returns {Resource}
 */
export function syntheticResource(o) {
  const climate = getClimate(o.climate);
  const k = dailyClearIndex(climate, o.seed, o.cloudScale);
  const hours = 365 * 24;
  const startMs = Date.UTC(YEAR, 0, 1);
  const poa = new Float64Array(hours);
  const tAmb = new Float64Array(hours);
  const panel = { tilt: o.tilt, azimuth: o.azimuth, albedo: o.albedo };
  for (let h = 0; h < hours; h++) {
    const day = Math.floor(h / 24);
    const hod = h % 24;
    const doy = day + 1;
    let sum = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      const frac = (s + 0.5) / SUBSTEPS;
      const utc = startMs + (h + frac - o.tz) * 3600000;
      const sun = sunPosition(utc, o.lat, o.lon);
      const ghi = haurwitzGhi(sun.zenith) * k[day];
      if (ghi > 0) sum += transpose(ghi, sun.zenith, sun.azimuth, doy, panel).poa;
    }
    poa[h] = sum / SUBSTEPS;
    tAmb[h] = airTemperature(climate, day, hod + 0.5);
  }
  return {
    kind: "synthetic",
    label: `Synthetic year: ${climate.label}, seed ${o.seed}${o.cloudScale !== 1 ? `, clouds x${o.cloudScale}` : ""}`,
    startMs,
    hours,
    poa,
    tAmb,
    tilt: o.tilt,
    azimuth: o.azimuth,
    notes: [
      `Cloudiness is a seeded random process (${climate.source}); it is illustrative, not a forecast or a climatology.`,
    ],
  };
}

/**
 * Shift a UTC-ordered hourly array so that index i is local hour i, wrapping
 * the hours that fall off one end round to the other.
 * @param {Float64Array} a
 * @param {number} shift whole hours
 * @returns {Float64Array}
 */
function rotate(a, shift) {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[(((i + shift) % n) + n) % n] = a[i];
  return out;
}

/**
 * @typedef {object} PvgisOptions
 * @property {number} tz hours east of UTC
 * @property {number} tilt used for TMY files (series files carry their own)
 * @property {number} azimuth
 * @property {number} albedo
 */

/**
 * Turn a parsed PVGIS file into a local-time resource. Hours are shifted by
 * the time zone rounded to a whole hour; the few hours that wrap from the end
 * of the file to the start are night-time in most of the world.
 * @param {PvgisData} data
 * @param {PvgisOptions} o
 * @returns {Resource}
 */
export function pvgisResource(data, o) {
  const shift = Math.round(o.tz);
  const first = new Date(data.times[0]);
  const startMs = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const n = data.times.length;
  const notes = [...data.warnings];
  const where = data.meta.lat !== null ? ` at ${data.meta.lat}, ${data.meta.lon}` : "";
  const db = data.meta.database ? `${data.meta.database}, ` : "";
  if (shift !== o.tz)
    notes.push(
      `Time zone ${o.tz} h rounded to ${shift} h to align the hourly rows with local hours.`,
    );
  if (data.kind === "series" && data.poa) {
    return {
      kind: "pvgis-series",
      label: `PVGIS hourly data${where} (${db}${new Date(data.times[0]).getUTCFullYear()}-${new Date(data.times[n - 1]).getUTCFullYear()})`,
      startMs,
      hours: n,
      poa: rotate(data.poa, shift),
      tAmb: rotate(data.tAmb, shift),
      tilt: data.meta.slope ?? o.tilt,
      azimuth: data.meta.azimuth ?? o.azimuth,
      notes,
    };
  }
  const ghi = /** @type {Float64Array} */ (data.ghi);
  const dni = /** @type {Float64Array} */ (data.dni);
  const dhi = /** @type {Float64Array} */ (data.dhi);
  const lat = data.meta.lat ?? 0;
  const lon = data.meta.lon ?? 0;
  const panel = { tilt: o.tilt, azimuth: o.azimuth, albedo: o.albedo };
  const poaUtc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (ghi[i] <= 0) continue;
    const t = data.times[i] + data.meta.timeOffsetH * 3600000;
    const sun = sunPosition(t, lat, lon);
    poaUtc[i] =
      sun.zenith < 89.5
        ? transposeComponents(ghi[i], dni[i], dhi[i], sun.zenith, sun.azimuth, panel).poa
        : transpose(ghi[i], sun.zenith, sun.azimuth, dayOfYear(t), panel).poa;
  }
  notes.push("TMY months come from different years; the file is treated as one continuous year.");
  return {
    kind: "pvgis-tmy",
    label: `PVGIS typical meteorological year${where}${data.meta.database ? ` (${data.meta.database})` : ""}`,
    startMs,
    hours: n,
    poa: rotate(poaUtc, shift),
    tAmb: rotate(data.tAmb, shift),
    tilt: o.tilt,
    azimuth: o.azimuth,
    notes,
  };
}
