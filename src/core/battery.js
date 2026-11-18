// Battery chemistry presets and the simple battery model used by the
// simulation: an energy bucket with a usable window, charge efficiency,
// charge-rate limit with a taper near full, temperature windows for
// charging, a cold derating of usable energy and self-discharge.
// Open-circuit voltage curves are coarse, illustrative tables used to turn
// a cut-off voltage into a state of charge; sag under load is not modelled.

/**
 * @typedef {object} Chemistry
 * @property {string} id
 * @property {string} label
 * @property {number} vnomCell nominal cell voltage, V
 * @property {Array<[number, number]>} ocv [state of charge 0..1, cell voltage V], increasing
 * @property {number} chargeEff fraction of the energy put in that can be taken out again
 * @property {number} selfDischargePerMonth fraction of the stored energy lost per month at room temperature
 * @property {number} maxChargeC charge current limit in C (1 C = capacity in A)
 * @property {number} maxDischargeC peak discharge current the model allows, in C
 * @property {number} taperFrom state of charge where accepted current starts to fall
 * @property {number} chargeTmin lowest temperature for charging, degC
 * @property {number} chargeTmax highest temperature for charging, degC
 * @property {number} coldLossPerK fraction of usable energy unavailable per kelvin below 20 degC
 * @property {number} defaultDod default usable depth of discharge
 * @property {number} defaultCutoffCell default low-voltage cut-off per cell, V
 */

/** @type {Chemistry[]} */
export const CHEMISTRIES = [
  {
    id: "liion",
    label: "Li-ion (NMC/LCO, e.g. 18650)",
    vnomCell: 3.7,
    ocv: [
      [0, 3.0],
      [0.05, 3.3],
      [0.1, 3.45],
      [0.2, 3.55],
      [0.3, 3.62],
      [0.4, 3.68],
      [0.5, 3.73],
      [0.6, 3.8],
      [0.7, 3.88],
      [0.8, 3.96],
      [0.9, 4.06],
      [1, 4.18],
    ],
    chargeEff: 0.95,
    selfDischargePerMonth: 0.03,
    maxChargeC: 0.5,
    maxDischargeC: 2,
    taperFrom: 0.8,
    chargeTmin: 0,
    chargeTmax: 45,
    coldLossPerK: 0.008,
    defaultDod: 0.8,
    defaultCutoffCell: 3.0,
  },
  {
    id: "lifepo4",
    label: "LiFePO4 (e.g. 18650/26650 LFP)",
    vnomCell: 3.2,
    ocv: [
      [0, 2.5],
      [0.05, 2.9],
      [0.1, 3.1],
      [0.2, 3.2],
      [0.3, 3.25],
      [0.5, 3.28],
      [0.7, 3.31],
      [0.9, 3.34],
      [0.95, 3.37],
      [1, 3.45],
    ],
    chargeEff: 0.96,
    selfDischargePerMonth: 0.03,
    maxChargeC: 1,
    maxDischargeC: 3,
    taperFrom: 0.9,
    chargeTmin: 0,
    chargeTmax: 45,
    coldLossPerK: 0.01,
    defaultDod: 0.9,
    defaultCutoffCell: 2.8,
  },
  {
    id: "nimh",
    label: "NiMH, standard (high self-discharge)",
    vnomCell: 1.2,
    ocv: [
      [0, 1.0],
      [0.05, 1.15],
      [0.1, 1.2],
      [0.2, 1.23],
      [0.5, 1.26],
      [0.8, 1.3],
      [0.95, 1.35],
      [1, 1.42],
    ],
    chargeEff: 0.75,
    selfDischargePerMonth: 0.2,
    maxChargeC: 0.1,
    maxDischargeC: 1,
    taperFrom: 0.9,
    chargeTmin: 0,
    chargeTmax: 45,
    coldLossPerK: 0.006,
    defaultDod: 0.8,
    defaultCutoffCell: 1.0,
  },
  {
    id: "nimh-lsd",
    label: "NiMH, low self-discharge (pre-charged type)",
    vnomCell: 1.2,
    ocv: [
      [0, 1.0],
      [0.05, 1.15],
      [0.1, 1.2],
      [0.2, 1.23],
      [0.5, 1.26],
      [0.8, 1.3],
      [0.95, 1.35],
      [1, 1.42],
    ],
    chargeEff: 0.75,
    selfDischargePerMonth: 0.015,
    maxChargeC: 0.1,
    maxDischargeC: 1,
    taperFrom: 0.9,
    chargeTmin: 0,
    chargeTmax: 45,
    coldLossPerK: 0.006,
    defaultDod: 0.8,
    defaultCutoffCell: 1.0,
  },
];

/**
 * @param {string} id
 * @returns {Chemistry}
 */
export function getChemistry(id) {
  const c = CHEMISTRIES.find((x) => x.id === id);
  if (!c)
    throw new Error(
      `unknown chemistry '${id}' (known: ${CHEMISTRIES.map((x) => x.id).join(", ")})`,
    );
  return c;
}

/**
 * Piecewise-linear interpolation in a table of increasing x.
 * @param {Array<[number, number]>} table
 * @param {number} x
 * @returns {number}
 */
export function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return table[table.length - 1][1];
}

/**
 * Open-circuit pack voltage at a state of charge.
 * @param {Chemistry} c
 * @param {number} cells in series
 * @param {number} soc 0..1
 * @returns {number}
 */
export function ocv(c, cells, soc) {
  return cells * interp(c.ocv, soc);
}

/**
 * State of charge at which the open-circuit pack voltage equals v.
 * @param {Chemistry} c
 * @param {number} cells
 * @param {number} v pack voltage
 * @returns {number} 0..1
 */
export function socAtVoltage(c, cells, v) {
  /** @type {Array<[number, number]>} */
  const inverse = c.ocv.map(([s, cv]) => [cv * cells, s]);
  return interp(inverse, v);
}

/**
 * Fraction of the usable window available at an air temperature (1 at or
 * above 20 degC, falling linearly below, never under 0.3).
 * @param {Chemistry} c
 * @param {number} t degC
 * @returns {number}
 */
export function coldFactor(c, t) {
  if (t >= 20) return 1;
  return Math.max(0.3, 1 - c.coldLossPerK * (20 - t));
}

/**
 * Self-discharge per hour as a fraction of the stored energy, from a monthly
 * figure (a month taken as 730 h).
 * @param {number} perMonth
 * @returns {number}
 */
export function selfDischargePerHour(perMonth) {
  if (perMonth <= 0) return 0;
  return 1 - Math.pow(1 - Math.min(perMonth, 0.99), 1 / 730);
}
