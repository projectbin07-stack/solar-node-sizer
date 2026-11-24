# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-11-24

### Fixed

- A scheduled state with a `from`/`to` window and a period longer than the
  window lost most of its events. The duty cycle `duration / every` was
  applied only inside the window, so "every 86400 s for 60 s between 12:00
  and 13:00" counted 1/24 of an event: 0.0694 instead of 1.6667 mAh/day at
  100 mA, understating that state's load 24x. `every` is now a wall-clock
  period: `W / every` events a day when it fits in the window of `W`
  seconds, otherwise one event per window (or one every n-th day for
  periods over a day), spread over the window's hours. An event longer than
  its window is capped and named in the overbooked warning. The bundled
  examples have no windows: their `simulate --json` and `size --json`
  output is byte-identical before and after.

### Added

- The browser app imports a configuration JSON, through a file picker
  under "Start from" or by dropping the file on the page. This is the file
  the CLI reads, including the export of embedded-power-profiler, which
  before could only be used with the CLI. Sections in the file replace the
  current ones; a load-only export changes only the load table. Tested in
  CI in headless Chrome over the DevTools protocol
  (`scripts/browser-import-test.js`).

## [0.1.1] - 2026-11-19

### Fixed

- Days of autonomy left out self-discharge, so v0.1.0 overstated it. It was
  `usable energy / daily load`; it is now the time a full battery keeps the
  node up with no harvest at 20 degC, applying the simulation's hourly
  self-discharge and load until the floor (closed form, documented in
  `docs/models.md` section 11). With zero self-discharge the result is
  unchanged. Bundled examples, before -> after: `esp32-wifi-10min` 130.92
  -> 119.34 days, `atmega-nrf24` 290.01 -> 247.55 days,
  `esp32-devboard-ams1117` 1.23 -> 1.21 days. Downtime, state of charge
  and sizing results did not change: autonomy is a reported figure only.
- The load-profile table no longer scrolls sideways on desktop: its columns
  take fixed shares of the settings panel, and on phones each state is laid
  out on two lines.

## [0.1.0] - 2026-11-19

First release.

### Added

- Solar geometry from the NOAA solar calculator equations, Haurwitz clear-sky
  irradiance, Erbs beam/diffuse split and isotropic-sky transposition with an
  ASHRAE incidence-angle modifier.
- Seeded synthetic weather (daily AR(1) cloudiness around monthly means and a
  daily temperature cycle) with presets fitted to one year of PVGIS data for
  Bengaluru, Mumbai, New Delhi, Chennai, Guwahati, Nairobi and Berlin, all
  labelled illustrative; `scripts/fit-climate.js` to fit more.
- Parser for PVGIS hourly-data and TMY CSV files downloaded by the user.
- Load profile with scheduled states and time windows; regulator models for
  no regulator, LDO (quiescent current, dropout) and switching converters
  (efficiency curve per state).
- Panel model with NOCT temperature, soiling and other losses; MPPT and
  linear/PWM charger models with a current limit.
- Battery presets for Li-ion, LiFePO4 and NiMH (standard and low
  self-discharge): usable window from depth of discharge, cut-off voltage and
  regulator minimum input; charge efficiency; C-rate with a taper solved
  within each hour; charging temperature window; cold derating;
  self-discharge; peak discharge-rate check.
- Hourly year simulation with warm-up, brown-out and restart, energy balance,
  downtime, lowest charge, days of autonomy and the worst consecutive-days
  deficit.
- Grid sizer over panel and battery sizes with automatic grids, Pareto
  frontier and lowest-cost choice.
- Browser app: load-profile editor, daily energy per state, state-of-charge
  heatmap, monthly energy bars, worst-week charts, sizing chart, summary,
  shareable URLs, CSV export, light/dark themes and phone layout.
- CLI (`simulate`, `size`, `presets`) with text and JSON output and CSV
  export; three illustrative example configurations.
- Tests with `node:test` and coverage thresholds, JSDoc type checking, CI on
  Ubuntu and Windows with Node 22 and 24, a headless Chrome smoke test and
  GitHub Pages deployment.

[0.1.1]: https://github.com/projectbin07-stack/solar-node-sizer/releases/tag/v0.1.1
[0.1.0]: https://github.com/projectbin07-stack/solar-node-sizer/releases/tag/v0.1.0
