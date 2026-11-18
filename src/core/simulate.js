// Hour-by-hour simulation of panel, charger, battery and node over the
// resource's time span (one year for the synthetic weather).

import { coldFactor, getChemistry, ocv, selfDischargePerHour } from "./battery.js";
import { batteryLimits } from "./config.js";
import { batteryPower, hourLoads } from "./load.js";
import { chargerOutput, powerPerWp } from "./pv.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./resource.js").Resource} Resource */

/**
 * @typedef {object} Totals energies in Wh over the simulated span
 * @property {number} pv panel DC output at the maximum power point
 * @property {number} offered charger output before the battery's acceptance limit
 * @property {number} accepted energy that entered the battery terminals
 * @property {number} stored accepted minus charge losses
 * @property {number} chargeLoss accepted minus stored
 * @property {number} clipped offered but not accepted (battery full, rate or temperature limit)
 * @property {number} load energy delivered to the node (at the battery)
 * @property {number} unserved energy the node would have used while it was down
 * @property {number} selfDischarge
 */

/**
 * @typedef {object} Deficit
 * @property {number} wh largest cumulative shortfall of harvest against load
 * @property {number} startDay first day of that run (0-based)
 * @property {number} days length of the run
 */

/**
 * @typedef {object} MonthStats
 * @property {number} harvestWh energy stored in the battery from the panel
 * @property {number} offeredWh charger output available
 * @property {number} loadWh
 * @property {number} downtimeHours
 * @property {number} days
 */

/**
 * @typedef {object} SimResult
 * @property {number} hours
 * @property {number} days
 * @property {number} startMs
 * @property {Float32Array} soc state of charge at the end of each hour
 * @property {Float32Array} pvW panel output of each hour (mean W)
 * @property {Float32Array} chargeW energy stored per hour (W)
 * @property {Float32Array} loadW energy delivered to the node per hour (W)
 * @property {Float32Array} down fraction of each hour the node was off
 * @property {Totals} totals
 * @property {number} eStartWh stored energy at the start (after warm-up)
 * @property {number} eEndWh
 * @property {number} downtimeHours
 * @property {number} downtimeEvents number of brown-outs
 * @property {number} longestOutageHours
 * @property {number} minSoc
 * @property {number} minSocHour
 * @property {MonthStats[]} months
 * @property {Deficit} deficit
 * @property {number} dailyLoadWh mean daily load at the nominal battery voltage
 * @property {number} autonomyDays days a full battery keeps the node up with no
 *   harvest, at 20 degC or above: the mean load at the nominal voltage plus
 *   self-discharge, applied hour by hour as in the simulation, until the
 *   stored energy reaches the floor (see autonomyHours). Infinity with no load.
 * @property {import("./config.js").BatteryLimits} limits
 * @property {number} worstWeekStartDay
 */

/**
 * Inputs that do not depend on the panel or battery size, so a sizer can
 * reuse them across many runs.
 * @typedef {object} Prepared
 * @property {Resource} resource
 * @property {Float64Array} pvPerWp panel output per rated watt, each hour
 * @property {import("./load.js").HourLoad[]} hourLoad
 */

/**
 * @param {Config} c
 * @param {Resource} resource
 * @returns {Prepared}
 */
export function prepare(c, resource) {
  const pvPerWp = new Float64Array(resource.hours);
  const panel = { ...c.panel, tilt: resource.tilt, azimuth: resource.azimuth };
  for (let h = 0; h < resource.hours; h++)
    pvPerWp[h] = powerPerWp(resource.poa[h], resource.tAmb[h], panel);
  return { resource, pvPerWp, hourLoad: hourLoads(c.load, c.regulator) };
}

/**
 * @typedef {object} SimOptions
 * @property {number} [wp] panel size override
 * @property {number} [capacityMah] battery size override
 * @property {boolean} [record] keep the hourly arrays (default true)
 */

/**
 * Run the simulation.
 *
 * Each hour, in order: self-discharge; the node's load if it is up; then
 * the charger output, limited by the battery's charge rate, the taper near
 * full and the charging temperature window (see chargeHour). If the
 * battery would end below its floor the node runs for the part of the hour
 * the energy covers and then browns out; it restarts once the battery is
 * back above the floor plus the restart margin. Charger output the battery
 * cannot take is counted as clipped.
 * @param {Config} c
 * @param {Prepared} prep
 * @param {SimOptions} [opts]
 * @returns {SimResult}
 */
export function simulate(c, prep, opts = {}) {
  const wp = opts.wp ?? c.panel.wp;
  const capacityMah = opts.capacityMah ?? c.battery.capacityMah;
  const record = opts.record ?? true;
  const { resource, pvPerWp, hourLoad } = prep;
  const n = resource.hours;
  const chem = getChemistry(c.battery.chemistry);
  const cells = c.battery.cells;
  const limits = batteryLimits(c, capacityMah);
  const eCap = limits.capacityWh;
  const usable = eCap * (1 - limits.socMin);
  const sdh = selfDischargePerHour(c.battery.selfDischargePerMonth);
  const acceptA = chem.maxChargeC * (capacityMah / 1000);
  const eta = chem.chargeEff;
  const startHourOfDay = new Date(resource.startMs).getUTCHours();

  let e = eCap * c.battery.initialSoc;
  let up = true;
  const years = c.simulation.warmupYears;

  /** @type {Totals} */
  let totals = zeroTotals();
  let downtime = 0;
  let events = 0;
  let outage = 0;
  let longest = 0;
  let minSoc = Infinity;
  let minSocHour = 0;
  let eStart = e;
  const soc = new Float32Array(record ? n : 0);
  const pvW = new Float32Array(record ? n : 0);
  const chargeW = new Float32Array(record ? n : 0);
  const loadW = new Float32Array(record ? n : 0);
  const down = new Float32Array(record ? n : 0);
  const days = Math.ceil(n / 24);
  const monthOfDay = new Uint8Array(days);
  for (let d = 0; d < days; d++)
    monthOfDay[d] = new Date(resource.startMs + d * 86400000).getUTCMonth();
  /** @type {MonthStats[]} */
  let months = [];
  const offeredByDay = new Float64Array(days);

  for (let pass = 0; pass <= years; pass++) {
    const final = pass === years;
    if (final) {
      totals = zeroTotals();
      downtime = 0;
      events = 0;
      outage = 0;
      longest = 0;
      minSoc = Infinity;
      eStart = e;
      months = Array.from({ length: 12 }, () => ({
        harvestWh: 0,
        offeredWh: 0,
        loadWh: 0,
        downtimeHours: 0,
        days: 0,
      }));
      for (let d = 0; d < days; d++) months[monthOfDay[d]].days++;
    }
    for (let h = 0; h < n; h++) {
      const tAmb = resource.tAmb[h];
      const s0 = e / eCap;
      const vbat = ocv(chem, cells, s0);
      const loss = e * sdh;
      e -= loss;
      const floor = eCap * limits.socMin + (1 - coldFactor(chem, tAmb)) * usable;
      const pv = wp * pvPerWp[h];
      const offered = chargerOutput(pv, vbat, c.charger, c.panel.vmp);
      const canCharge = tAmb >= chem.chargeTmin && tAmb <= chem.chargeTmax;
      const acceptW = canCharge ? acceptA * vbat : 0;
      const hl = hourLoad[(startHourOfDay + h) % 24];
      const demand = batteryPower(c.regulator, vbat, hl.meanMa, hl.convertedW);
      let served = 0;
      let downFrac = 0;
      let accepted;
      if (up) {
        const from = Math.max(0, e - demand);
        accepted = chargeHour(from / eCap, offered, acceptW, eta, eCap, chem.taperFrom) / eta;
        const net = e + accepted * eta - demand;
        if (net >= floor) {
          served = demand;
          e = net;
        } else {
          const f =
            demand > 0 ? Math.min(1, Math.max(0, (e + accepted * eta - floor) / demand)) : 1;
          served = f * demand;
          downFrac = 1 - f;
          e = e + accepted * eta - served;
          up = false;
          if (final) events++;
        }
      } else {
        accepted = chargeHour(e / eCap, offered, acceptW, eta, eCap, chem.taperFrom) / eta;
        e = e + accepted * eta;
        downFrac = 1;
        if (e >= floor + c.simulation.restartFraction * usable) up = true;
      }
      if (!final) continue;
      const day = Math.floor(h / 24);
      const m = months[monthOfDay[day]];
      totals.pv += pv;
      totals.offered += offered;
      totals.accepted += accepted;
      totals.stored += accepted * eta;
      totals.chargeLoss += accepted * (1 - eta);
      totals.clipped += offered - accepted;
      totals.load += served;
      totals.unserved += demand - served;
      totals.selfDischarge += loss;
      m.harvestWh += accepted * eta;
      m.offeredWh += offered;
      m.loadWh += served;
      m.downtimeHours += downFrac;
      offeredByDay[day] += offered * eta;
      downtime += downFrac;
      if (downFrac > 0) {
        outage += downFrac;
        longest = Math.max(longest, outage);
      } else outage = 0;
      const sNow = e / eCap;
      if (sNow < minSoc) {
        minSoc = sNow;
        minSocHour = h;
      }
      if (record) {
        soc[h] = sNow;
        pvW[h] = pv;
        chargeW[h] = accepted * eta;
        loadW[h] = served;
        down[h] = downFrac;
      }
    }
  }

  let dailyLoadWh = 0;
  for (const hl of hourLoad)
    dailyLoadWh += batteryPower(c.regulator, limits.vnom, hl.meanMa, hl.convertedW);
  const deficit = worstDeficit(offeredByDay, dailyLoadWh);
  return {
    hours: n,
    days,
    startMs: resource.startMs,
    soc,
    pvW,
    chargeW,
    loadW,
    down,
    totals,
    eStartWh: eStart,
    eEndWh: e,
    downtimeHours: downtime,
    downtimeEvents: events,
    longestOutageHours: longest,
    minSoc,
    minSocHour,
    months,
    deficit,
    dailyLoadWh,
    autonomyDays: autonomyHours(eCap, eCap * limits.socMin, dailyLoadWh / 24, sdh) / 24,
    limits,
    worstWeekStartDay: worstWeekStart(record ? down : null, minSocHour, days),
  };
}

/**
 * How long a battery lasts with no harvest, stepping the simulation's
 * order for each hour: self-discharge first (a fraction `sdh` of the stored
 * energy), then the load. With a constant load `p` per hour the energy after
 * k whole hours is, in closed form,
 *   E_k = (E_0 + p/s) (1 - s)^k - p/s        (s = sdh > 0)
 *   E_k = E_0 - k p                          (s = 0)
 * The result is the last whole hour N that ends at or above the floor plus
 * the fraction of the next hour the remaining energy covers after that
 * hour's self-discharge, ((1 - s) E_N - floor) / p, which is how the
 * simulation splits the hour in which the node browns out. With s = 0 this
 * is exactly (E_0 - floor) / p.
 * @param {number} e0 starting stored energy, Wh
 * @param {number} floorWh energy at which the node stops, Wh
 * @param {number} loadWh load per hour, Wh
 * @param {number} sdh self-discharge per hour, fraction of the stored energy
 * @returns {number} hours (Infinity with no load)
 */
export function autonomyHours(e0, floorWh, loadWh, sdh) {
  if (!(loadWh > 0)) return Infinity;
  if (e0 <= floorWh) return 0;
  const s = Math.max(0, sdh);
  const q = s > 0 ? loadWh / s : 0;
  /** @param {number} k */
  const after = (k) => (s > 0 ? (e0 + q) * Math.pow(1 - s, k) - q : e0 - k * loadWh);
  // Real-valued k where E_k = floor; N is the whole hours before it.
  const kReal =
    s > 0 ? Math.log((floorWh + q) / (e0 + q)) / Math.log(1 - s) : (e0 - floorWh) / loadWh;
  let n = Math.max(0, Math.floor(kReal));
  // Guard against rounding in the logarithms.
  while (n > 0 && after(n) < floorWh) n--;
  while (after(n + 1) >= floorWh) n++;
  const frac = ((1 - s) * after(n) - floorWh) / loadWh;
  return n + Math.min(1, Math.max(0, frac));
}

/**
 * Energy stored during one hour of charging, solving
 *   dE/dt = eta * min(P, k * taper(E / Ecap))
 * exactly: constant power until the tapering acceptance falls below P, then
 * an exponential approach along the linear taper, stopping at full. Solving
 * it within the hour (rather than holding the hour's starting acceptance)
 * keeps the result monotonic in the starting charge.
 * @param {number} soc state of charge at the start, 0..1
 * @param {number} offeredW charger output, W
 * @param {number} acceptW battery acceptance before taper (C-rate x voltage), W
 * @param {number} eta charge efficiency
 * @param {number} capWh battery capacity, Wh
 * @param {number} taperFrom state of charge where the taper starts (< 1)
 * @returns {number} energy stored, Wh
 */
export function chargeHour(soc, offeredW, acceptW, eta, capWh, taperFrom) {
  if (offeredW <= 0 || acceptW <= 0 || soc >= 1) return 0;
  // taper(s) = alpha - beta s above taperFrom: 1 at taperFrom, 0.05 at full.
  const beta = 0.95 / (1 - taperFrom);
  const alpha = 1 + beta * taperFrom;
  const p = Math.min(offeredW, acceptW);
  const sStar = offeredW >= acceptW ? taperFrom : Math.min(1, (alpha - offeredW / acceptW) / beta);
  let s = soc;
  let t = 1;
  if (s < sStar) {
    const rate = (eta * p) / capWh;
    const need = (sStar - s) / rate;
    if (need >= t) return rate * t * capWh;
    s = sStar;
    t -= need;
  }
  if (s >= 1) return (1 - soc) * capWh;
  const sInf = alpha / beta;
  const q = (eta * acceptW) / capWh;
  const end = Math.min(1, sInf - (sInf - s) * Math.exp(-q * beta * t));
  return (end - soc) * capWh;
}

/** @returns {Totals} */
function zeroTotals() {
  return {
    pv: 0,
    offered: 0,
    accepted: 0,
    stored: 0,
    chargeLoss: 0,
    clipped: 0,
    load: 0,
    unserved: 0,
    selfDischarge: 0,
  };
}

/**
 * Largest run of consecutive days over which load exceeds what the panel
 * could have put into the battery (an infinite battery, no clipping):
 * running deficit d = max(0, d + load - harvest), tracking its maximum.
 * @param {ArrayLike<number>} harvestByDay storable harvest per day, Wh
 * @param {number} loadPerDay Wh
 * @returns {Deficit}
 */
export function worstDeficit(harvestByDay, loadPerDay) {
  let run = 0;
  let runStart = 0;
  /** @type {Deficit} */
  let best = { wh: 0, startDay: 0, days: 0 };
  for (let d = 0; d < harvestByDay.length; d++) {
    const next = run + loadPerDay - harvestByDay[d];
    if (next <= 0) {
      run = 0;
      runStart = d + 1;
      continue;
    }
    run = next;
    if (run > best.wh) best = { wh: run, startDay: runStart, days: d - runStart + 1 };
  }
  return best;
}

/**
 * First day of the week to zoom on: the week with the most downtime, or the
 * week leading up to the lowest state of charge.
 * @param {Float32Array | null} down
 * @param {number} minSocHour
 * @param {number} days
 * @returns {number}
 */
function worstWeekStart(down, minSocHour, days) {
  const span = Math.min(7, days);
  let start = Math.floor(minSocHour / 24) - (span - 2);
  if (down) {
    const daily = new Float64Array(days);
    for (let h = 0; h < down.length; h++) daily[Math.floor(h / 24)] += down[h];
    let best = 0;
    let bestStart = -1;
    let sum = 0;
    for (let d = 0; d < days; d++) {
      sum += daily[d];
      if (d >= span) sum -= daily[d - span];
      if (d >= span - 1 && sum > best) {
        best = sum;
        bestStart = d - span + 1;
      }
    }
    if (bestStart >= 0) start = bestStart;
  }
  return Math.max(0, Math.min(days - span, start));
}
