// The example configurations, also shipped as examples/*.json for the CLI
// (a test keeps the two in step). All values are illustrative.

/** @type {Array<{id: string, label: string, config: Record<string, unknown>}>} */
export const EXAMPLES = [
  {
    id: "esp32-wifi-10min",
    label: "ESP32 + Wi-Fi every 10 min (Bengaluru)",
    config: {
      name: "ESP32 + BME280, Wi-Fi report every 10 min, Bengaluru (illustrative)",
      note: "Illustrative example, not a measured node. Currents are datasheet-order figures for an ESP32 module on a board with a low-Iq LDO; measure your own board.",
      location: { lat: 12.97, lon: 77.59, tz: 5.5, climate: "bengaluru", seed: 1, cloudScale: 1 },
      panel: {
        wp: 1,
        tilt: 15,
        azimuth: 180,
        tempCoeff: -0.004,
        noct: 48,
        soiling: 0.05,
        vmp: 6,
        otherLosses: 0.1,
      },
      charger: { type: "linear", efficiency: 0.97, maxCurrentMa: 500 },
      battery: { chemistry: "liion", cells: 1, capacityMah: 2500, dod: 0.8, cutoffV: 3 },
      regulatorPreset: "ldo-lowiq",
      load: [
        { name: "Deep sleep (RTC timer)", mA: 0.015, base: true },
        { name: "Boot + BME280 read", mA: 40, every: 600, duration: 0.3 },
        { name: "Wi-Fi connect + MQTT", mA: 120, every: 600, duration: 3 },
      ],
      sizer: { panelWp: [], batteryMah: [], maxDowntimeHours: 0, costPerWp: 1, costPerAh: 1 },
    },
  },
  {
    id: "atmega-nrf24",
    label: "ATmega328P + nRF24L01+ every minute (Mumbai)",
    config: {
      name: "ATmega328P + nRF24L01+ + DS18B20, report every minute, Mumbai (illustrative)",
      note: "Illustrative example, not a measured node. LiFePO4 powers the node directly: a full LFP cell (about 3.45 V at rest, 3.6 V while charging) stays within the nRF24L01+ 3.6 V maximum. Currents are datasheet-order figures.",
      location: { lat: 19.08, lon: 72.88, tz: 5.5, climate: "mumbai", seed: 1, cloudScale: 1 },
      panel: {
        wp: 0.3,
        tilt: 20,
        azimuth: 180,
        tempCoeff: -0.004,
        noct: 48,
        soiling: 0.05,
        vmp: 5,
        otherLosses: 0.1,
      },
      charger: { type: "linear", efficiency: 0.97, maxCurrentMa: 200 },
      battery: { chemistry: "lifepo4", cells: 1, capacityMah: 600, dod: 0.9, cutoffV: 2.8 },
      regulatorPreset: "none",
      regulator: { nodeMinV: 2.7 },
      load: [
        { name: "Power-down + WDT", mA: 0.006, base: true },
        { name: "Wake + DS18B20 conversion", mA: 5, every: 60, duration: 0.8 },
        { name: "nRF24 TX + auto-ack", mA: 15, every: 60, duration: 0.02 },
      ],
      sizer: { panelWp: [], batteryMah: [], maxDowntimeHours: 0, costPerWp: 1, costPerAh: 1 },
    },
  },
  {
    id: "esp32-devboard-ams1117",
    label: "ESP32 dev board with AMS1117 LDO (Mumbai)",
    config: {
      name: "ESP32 dev board (AMS1117 LDO), Wi-Fi report every 10 min, Mumbai (illustrative)",
      note: "Illustrative example of a common mistake: the same ESP32 duty cycle as esp32-wifi-10min.json, but on a dev board whose AMS1117-class LDO draws about 5 mA all the time and drops about 1.1 V. Currents are datasheet-order figures, not measurements.",
      location: { lat: 19.08, lon: 72.88, tz: 5.5, climate: "mumbai", seed: 1, cloudScale: 1 },
      panel: {
        wp: 1,
        tilt: 20,
        azimuth: 180,
        tempCoeff: -0.004,
        noct: 48,
        soiling: 0.05,
        vmp: 6,
        otherLosses: 0.1,
      },
      charger: { type: "linear", efficiency: 0.97, maxCurrentMa: 500 },
      battery: { chemistry: "liion", cells: 1, capacityMah: 2500, dod: 0.8, cutoffV: 3 },
      regulatorPreset: "ldo-ams1117",
      load: [
        { name: "Deep sleep (RTC timer)", mA: 0.015, base: true },
        { name: "Boot + BME280 read", mA: 40, every: 600, duration: 0.3 },
        { name: "Wi-Fi connect + MQTT", mA: 120, every: 600, duration: 3 },
      ],
      sizer: { panelWp: [], batteryMah: [], maxDowntimeHours: 0, costPerWp: 1, costPerAh: 1 },
    },
  },
];
