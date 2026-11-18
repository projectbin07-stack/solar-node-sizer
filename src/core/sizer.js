// Grid search over panel size and battery capacity.

import { getChemistry } from "./battery.js";
import { batteryLimits } from "./config.js";
import { batteryPower, peakBatteryMa } from "./load.js";
import { prepare, simulate } from "./simulate.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./simulate.js").Prepared} Prepared */

/**
 * @typedef {object} SizePoint
 * @property {number} wp
 * @property {number} capacityMah
 * @property {number} downtimeHours
 * @property {number} minSoc
 * @property {number} cost relative cost from the configured weights
 */

/**
 * @typedef {object} SizeResult
 * @property {number[]} panelWp sorted grid
 * @property {number[]} batteryMah sorted grid
 * @property {number[][]} downtime downtime[i][j] for panelWp[i], batteryMah[j]
 * @property {boolean[]} peakLimited batteryMah[j] cannot deliver the peak load current
 *   (those combinations are simulated but never chosen)
 * @property {number} minMahForPeak smallest capacity that delivers the peak current
 * @property {SizePoint[]} frontier non-dominated combinations that meet the target, by panel size
 * @property {SizePoint | null} best lowest-cost combination that meets the target
 * @property {number} target allowed downtime, hours
 * @property {number} runs simulations performed
 */

/**
 * Simulate every combination of the panel and battery grids and keep the
 * Pareto frontier of those that meet the downtime target: for each panel
 * size the smallest battery that works, dropping any point for which a
 * smaller-or-equal panel already works with a smaller-or-equal battery.
 * Every combination is simulated, so the result does not rely on downtime
 * being monotonic in either size.
 * @param {Config} c
 * @param {Prepared | import("./resource.js").Resource} input a prepared
 *   resource, or a raw resource to prepare
 * @returns {SizeResult}
 */
export function size(c, input) {
  const prep = "pvPerWp" in input ? input : prepare(c, input);
  const auto = autoGrid(c, prep);
  const panelWp = [...new Set(c.sizer.panelWp.length ? c.sizer.panelWp : auto.panelWp)].sort(
    (a, b) => a - b,
  );
  const batteryMah = [
    ...new Set(c.sizer.batteryMah.length ? c.sizer.batteryMah : auto.batteryMah),
  ].sort((a, b) => a - b);
  const target = c.sizer.maxDowntimeHours;
  const minMahForPeak = minCapacityForPeak(c);
  const peakLimited = batteryMah.map((m) => m < minMahForPeak);
  /** @type {number[][]} */
  const downtime = [];
  /** @type {SizePoint[]} */
  const ok = [];
  let runs = 0;
  for (const wp of panelWp) {
    /** @type {number[]} */
    const row = [];
    for (const capacityMah of batteryMah) {
      const r = simulate(c, prep, { wp, capacityMah, record: false });
      runs++;
      const dt = round3(r.downtimeHours);
      row.push(dt);
      if (dt <= target && capacityMah >= minMahForPeak)
        ok.push({
          wp,
          capacityMah,
          downtimeHours: dt,
          minSoc: r.minSoc,
          cost: wp * c.sizer.costPerWp + (capacityMah / 1000) * c.sizer.costPerAh,
        });
    }
    downtime.push(row);
  }
  /** @type {SizePoint[]} */
  const frontier = [];
  let smallestBattery = Infinity;
  for (const wp of panelWp) {
    const forPanel = ok.filter((p) => p.wp === wp);
    if (forPanel.length === 0) continue;
    const p = forPanel.reduce((a, b) => (b.capacityMah < a.capacityMah ? b : a));
    if (p.capacityMah < smallestBattery) {
      frontier.push(p);
      smallestBattery = p.capacityMah;
    }
  }
  const best = ok.length > 0 ? ok.reduce((a, b) => (b.cost < a.cost - 1e-12 ? b : a)) : null;
  return {
    panelWp,
    batteryMah,
    downtime,
    peakLimited,
    minMahForPeak,
    frontier,
    best,
    target,
    runs,
  };
}

/**
 * Smallest capacity whose discharge-rate limit covers the peak load current.
 * @param {Config} c
 * @returns {number} mAh
 */
export function minCapacityForPeak(c) {
  const chem = getChemistry(c.battery.chemistry);
  const lim = batteryLimits(c);
  return peakBatteryMa(c.load, c.regulator, lim.vnom) / chem.maxDischargeC;
}

const NICE = [1, 1.5, 2, 3, 5, 7.5];

/**
 * Nearest value of the form {1, 1.5, 2, 3, 5, 7.5} x 10^k (in log terms).
 * @param {number} x > 0
 * @returns {number}
 */
export function nice(x) {
  const k = Math.floor(Math.log10(x));
  let best = NICE[0] * 10 ** k;
  for (const m of [...NICE, 10]) {
    const v = m * 10 ** k;
    if (Math.abs(Math.log(v / x)) < Math.abs(Math.log(best / x))) best = v;
  }
  return Number(best.toPrecision(3));
}

/**
 * Smallest nice value >= x.
 * @param {number} x > 0
 * @returns {number}
 */
export function niceCeil(x) {
  const k = Math.floor(Math.log10(x));
  for (const m of [...NICE, 10]) {
    const v = Number((m * 10 ** k).toPrecision(3));
    if (v >= x * (1 - 1e-12)) return v;
  }
  return 10 ** (k + 1);
}

/**
 * Up to `count` nice values spaced evenly in log between lo and hi.
 * @param {number} lo
 * @param {number} hi
 * @param {number} count
 * @returns {number[]}
 */
export function niceRange(lo, hi, count) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    let v = nice(lo * (hi / lo) ** (i / (count - 1)));
    if (v < lo) v = niceCeil(lo);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Grids scaled to the load when the configuration leaves them empty:
 * panels from a quarter to eight times a rough "3 sun-hours at 50 %
 * overall efficiency" estimate, batteries from half a day to 40 days of
 * autonomy. Only the search range depends on these estimates.
 * @param {Config} c
 * @param {Prepared} prep
 * @returns {{panelWp: number[], batteryMah: number[]}}
 */
export function autoGrid(c, prep) {
  const lim = batteryLimits(c);
  let dailyWh = 0;
  for (const hl of prep.hourLoad)
    dailyWh += batteryPower(c.regulator, lim.vnom, hl.meanMa, hl.convertedW);
  dailyWh = Math.max(dailyWh, 1e-4);
  const wpRef = dailyWh / (3 * 0.5);
  const usableFrac = Math.max(0.05, 1 - lim.socMin);
  const mahPerDay = (dailyWh / (lim.vnom * usableFrac)) * 1000;
  return {
    panelWp: niceRange(Math.max(0.005, wpRef / 4), Math.max(0.01, wpRef * 8), 10),
    batteryMah: niceRange(
      Math.max(10, mahPerDay * 0.5, minCapacityForPeak(c)),
      Math.max(20, mahPerDay * 40, minCapacityForPeak(c) * 10),
      10,
    ),
  };
}

/**
 * @param {number} x
 * @returns {number}
 */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
