# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/projectbin07-stack/solar-node-sizer/releases/tag/v0.1.0
