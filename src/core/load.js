// Load profile: operating states with their supply current and schedule,
// and the regulator between the battery and the node.

/**
 * One operating state. The base state (sleep, normally) fills whatever time
 * the scheduled states leave in each hour.
 * @typedef {object} LoadState
 * @property {string} name
 * @property {number} mA current drawn at the regulated supply voltage
 * @property {boolean} [base] fills the remaining time (exactly one state)
 * @property {number} [every] seconds between events (scheduled states)
 * @property {number} [duration] seconds per event (scheduled states)
 * @property {number} [from] first local hour the state is scheduled (default 0)
 * @property {number} [to] local hour it stops (exclusive, default 24; from > to wraps midnight)
 */

/**
 * @typedef {object} Regulator
 * @property {"none" | "ldo" | "switching"} type
 * @property {number} vout regulated output, V (ignored for "none")
 * @property {number} iqUa quiescent current drawn from the battery, uA
 * @property {number} dropout LDO dropout voltage, V
 * @property {number} minVin switching regulator: lowest input at which the
 *   output still satisfies the node (including 100 % duty pass-through), V
 * @property {number} nodeMinV lowest supply voltage the node itself works at, V
 * @property {Array<[number, number]>} efficiency switching efficiency
 *   curve as [load current mA, efficiency 0..1], interpolated in log(current)
 */

/** @type {Record<string, {label: string, regulator: Regulator}>} */
export const REGULATOR_PRESETS = {
  none: {
    label: "None (node runs straight from the battery)",
    regulator: {
      type: "none",
      vout: 0,
      iqUa: 0,
      dropout: 0,
      minVin: 0,
      nodeMinV: 2.7,
      efficiency: [],
    },
  },
  "ldo-lowiq": {
    label: "LDO 3.3 V, low Iq (MCP1700-class: 1.6 uA, 0.18 V dropout)",
    regulator: {
      type: "ldo",
      vout: 3.3,
      iqUa: 1.6,
      dropout: 0.18,
      minVin: 0,
      nodeMinV: 3.0,
      efficiency: [],
    },
  },
  "ldo-ams1117": {
    label: "LDO 3.3 V, AMS1117-class (5 mA ground current, 1.1 V dropout)",
    regulator: {
      type: "ldo",
      vout: 3.3,
      iqUa: 5000,
      dropout: 1.1,
      minVin: 0,
      nodeMinV: 3.0,
      efficiency: [],
    },
  },
  buck: {
    label: "Buck 3.3 V, light-load optimised (illustrative curve, 0.36 uA Iq)",
    regulator: {
      type: "switching",
      vout: 3.3,
      iqUa: 0.36,
      dropout: 0,
      minVin: 3.1,
      nodeMinV: 3.0,
      efficiency: [
        [0.001, 0.6],
        [0.01, 0.8],
        [0.1, 0.88],
        [1, 0.9],
        [10, 0.92],
        [100, 0.92],
        [500, 0.88],
      ],
    },
  },
  "buck-boost": {
    label: "Buck-boost 3.3 V (illustrative curve, 25 uA Iq)",
    regulator: {
      type: "switching",
      vout: 3.3,
      iqUa: 25,
      dropout: 0,
      minVin: 2.0,
      nodeMinV: 3.0,
      efficiency: [
        [0.01, 0.4],
        [0.1, 0.65],
        [1, 0.8],
        [10, 0.88],
        [100, 0.9],
        [500, 0.87],
      ],
    },
  },
};

/**
 * Efficiency at a load current, interpolated linearly in log10(current)
 * and held flat beyond the ends of the curve.
 * @param {Array<[number, number]>} curve
 * @param {number} mA
 * @returns {number}
 */
export function efficiencyAt(curve, mA) {
  if (curve.length === 0) return 1;
  if (mA <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (mA >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (mA <= x1) {
      const [x0, y0] = curve[i - 1];
      const f = (Math.log10(mA) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0));
      return y0 + f * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Lowest battery voltage at which the node still gets a supply it works on.
 *  - LDO: in dropout the output follows the input minus the dropout, so the
 *    battery must stay above min(Vout, node minimum) + dropout.
 *  - Switching: its stated minimum input.
 *  - None: the node's own minimum supply voltage.
 * @param {Regulator} r
 * @returns {number}
 */
export function regulatorMinVin(r) {
  if (r.type === "ldo") return Math.min(r.vout, r.nodeMinV) + r.dropout;
  if (r.type === "switching") return r.minVin;
  return r.nodeMinV;
}

/**
 * Is a scheduled state active during a given local hour?
 * @param {LoadState} s
 * @param {number} hour 0..23
 * @returns {boolean}
 */
export function activeInHour(s, hour) {
  const from = s.from ?? 0;
  const to = s.to ?? 24;
  if (from === to) return true; // same start and end: all day
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/**
 * Fraction of time a scheduled state is on while it is active.
 * @param {LoadState} s
 * @returns {number}
 */
export function dutyFraction(s) {
  if (s.base) return 0;
  const every = s.every ?? 0;
  const duration = s.duration ?? 0;
  if (!(every > 0) || !(duration > 0)) return 0;
  return Math.min(1, duration / every);
}

/**
 * Time share of each state in each hour of the day: shares[hour][state].
 * Scheduled states take their duty fraction; the base state takes the rest.
 * If scheduled states add up to more than the hour they are scaled down
 * (reported in `overbooked`).
 * @param {LoadState[]} states
 * @returns {{shares: number[][], overbooked: number[]}}
 */
export function hourlyShares(states) {
  const baseIdx = states.findIndex((s) => s.base);
  /** @type {number[][]} */
  const shares = [];
  /** @type {number[]} */
  const overbooked = [];
  for (let h = 0; h < 24; h++) {
    const row = states.map((s) => (!s.base && activeInHour(s, h) ? dutyFraction(s) : 0));
    const busy = row.reduce((a, b) => a + b, 0);
    if (busy > 1) {
      overbooked.push(h);
      for (let i = 0; i < row.length; i++) row[i] /= busy;
    } else if (baseIdx >= 0) row[baseIdx] = 1 - busy;
    shares.push(row);
  }
  return { shares, overbooked };
}

/**
 * Battery power drawn for a set of (time share, current) pairs.
 * @param {Regulator} r
 * @param {number} vbat battery voltage, V
 * @param {number} meanMa time-weighted mean load current, mA
 * @param {number} convertedW for a switching regulator: sum of share * I * Vout / eta(I), W
 * @returns {number} W
 */
export function batteryPower(r, vbat, meanMa, convertedW) {
  const iq = r.iqUa * 1e-6;
  if (r.type === "ldo") return vbat * (meanMa / 1000 + iq);
  if (r.type === "switching") return convertedW + vbat * iq;
  return vbat * (meanMa / 1000);
}

/**
 * Per-hour-of-day load figures, precomputed so the simulation only has to
 * apply the battery voltage.
 * @typedef {object} HourLoad
 * @property {number} meanMa mean supply-side current, mA
 * @property {number} convertedW switching-regulator input power before Iq, W
 */

/**
 * @param {LoadState[]} states
 * @param {Regulator} r
 * @returns {HourLoad[]} 24 entries
 */
export function hourLoads(states, r) {
  const { shares } = hourlyShares(states);
  return shares.map((row) => {
    let meanMa = 0;
    let convertedW = 0;
    row.forEach((share, i) => {
      const mA = states[i].mA;
      meanMa += share * mA;
      if (r.type === "switching" && mA > 0)
        convertedW += (share * (mA / 1000) * r.vout) / efficiencyAt(r.efficiency, mA);
    });
    return { meanMa, convertedW };
  });
}

/**
 * @typedef {object} StateBudget
 * @property {string} name
 * @property {number} hoursPerDay time spent in the state
 * @property {number} mAhPerDay charge at the supply side
 * @property {number} WhPerDay energy at the battery, at the nominal battery voltage
 */

/**
 * @typedef {object} DailyBudget
 * @property {StateBudget[]} states
 * @property {number} regulatorWhPerDay quiescent current and conversion loss, at the battery
 * @property {number} WhPerDay total from the battery
 * @property {number} mAhPerDay total battery charge per day at the nominal voltage
 * @property {number} averageMa mean battery current at the nominal voltage
 * @property {number[]} overbookedHours hours where scheduled states exceed 100 %
 */

/**
 * Daily energy budget per state, seen from the battery at its nominal voltage.
 * Supply-side energy uses the regulator output voltage (or the battery
 * voltage when there is no regulator).
 * @param {LoadState[]} states
 * @param {Regulator} r
 * @param {number} vnom nominal battery voltage
 * @returns {DailyBudget}
 */
export function dailyBudget(states, r, vnom) {
  const { shares, overbooked } = hourlyShares(states);
  const vSupply = r.type === "none" ? vnom : r.vout;
  /** @type {StateBudget[]} */
  const out = states.map((s) => ({ name: s.name, hoursPerDay: 0, mAhPerDay: 0, WhPerDay: 0 }));
  let total = 0;
  for (const row of shares) {
    row.forEach((share, i) => {
      out[i].hoursPerDay += share;
      out[i].mAhPerDay += share * states[i].mA;
      out[i].WhPerDay += (share * states[i].mA * vSupply) / 1000;
    });
  }
  for (const h of hourLoads(states, r)) total += batteryPower(r, vnom, h.meanMa, h.convertedW);
  const supplyWh = out.reduce((a, s) => a + s.WhPerDay, 0);
  const regulatorWh = Math.max(0, total - supplyWh);
  return {
    states: out,
    regulatorWhPerDay: regulatorWh,
    WhPerDay: total,
    mAhPerDay: (total / vnom) * 1000,
    averageMa: (total / vnom / 24) * 1000,
    overbookedHours: overbooked,
  };
}

/**
 * Highest battery current of any state (at the nominal battery voltage),
 * used to reject batteries too small to deliver the peak.
 * @param {LoadState[]} states
 * @param {Regulator} r
 * @param {number} vnom
 * @returns {number} mA
 */
export function peakBatteryMa(states, r, vnom) {
  let peak = 0;
  for (const s of states) {
    let ma = s.mA;
    if (r.type === "ldo") ma += r.iqUa / 1000;
    else if (r.type === "switching" && s.mA > 0)
      ma = (s.mA * r.vout) / (efficiencyAt(r.efficiency, s.mA) * vnom) + r.iqUa / 1000;
    peak = Math.max(peak, ma);
  }
  return peak;
}
