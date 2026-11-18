// Panel output and charger models.

/**
 * @typedef {object} Panel
 * @property {number} wp rated power at STC (1000 W/m^2, 25 degC cell), W
 * @property {number} tilt degrees
 * @property {number} azimuth degrees clockwise from north (180 = facing south)
 * @property {number} albedo ground reflectance
 * @property {number} tempCoeff relative power change per kelvin, e.g. -0.004
 * @property {number} noct nominal operating cell temperature, degC
 * @property {number} soiling fraction of light lost to dirt, 0..1
 * @property {number} otherLosses other DC losses as a fraction: wiring, mismatch,
 *   rating tolerance, poor low-light performance (PVGIS suggests 14 % for
 *   whole systems; small panels are often worse)
 * @property {number} vmp maximum-power-point voltage at STC, V (used by the linear charger)
 */

/**
 * @typedef {object} Charger
 * @property {"mppt" | "linear"} type
 * @property {number} efficiency mppt: conversion and tracking efficiency;
 *   linear: share of the panel current that reaches the battery
 * @property {number} maxCurrentMa charge current limit, mA
 */

/**
 * Cell temperature with the NOCT model: Tc = Ta + G (NOCT - 20) / 800.
 * @param {number} tAmb degC
 * @param {number} poa W/m^2
 * @param {number} noct degC
 * @returns {number}
 */
export function cellTemperature(tAmb, poa, noct) {
  return tAmb + (poa * (noct - 20)) / 800;
}

/**
 * Panel DC power per rated watt at the maximum power point:
 * (G / 1000) (1 + gamma (Tc - 25)) (1 - soiling) (1 - otherLosses), never negative.
 * @param {number} poa W/m^2
 * @param {number} tAmb degC
 * @param {Panel} p
 * @returns {number} W per Wp
 */
export function powerPerWp(poa, tAmb, p) {
  if (poa <= 0) return 0;
  const tc = cellTemperature(tAmb, poa, p.noct);
  const derate = (1 - p.soiling) * (1 - p.otherLosses);
  return Math.max(0, (poa / 1000) * (1 + p.tempCoeff * (tc - 25)) * derate);
}

/**
 * Power the charger delivers towards the battery, before the battery's own
 * acceptance limit.
 *  - MPPT: panel power times efficiency.
 *  - Linear (TP4056-style) or PWM: the panel is pulled down to the battery
 *    voltage, so the charge current is about the panel's maximum-power
 *    current Pmp / Vmp and the power is that current times the battery
 *    voltage. Energy between Vmp and Vbat is lost.
 * Both are capped at the charge current limit.
 * @param {number} panelW panel power at its maximum power point, W
 * @param {number} vbat battery voltage, V
 * @param {Charger} c
 * @param {number} vmp panel Vmp, V
 * @returns {number} W
 */
export function chargerOutput(panelW, vbat, c, vmp) {
  if (panelW <= 0) return 0;
  const limitW = (c.maxCurrentMa / 1000) * vbat;
  if (c.type === "mppt") return Math.min(panelW * c.efficiency, limitW);
  const current = (panelW / vmp) * c.efficiency;
  return Math.min(current * vbat, limitW);
}
