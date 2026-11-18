# Models, equations and sources

Everything Solar Node Sizer reports comes from the models below. They are
deliberately simple, documented and testable. They are **not** validated
against measured battery data from a real node. Where a number is a preset
or a default, it is illustrative and should be replaced by your own
datasheet values or measurements.

Contents: [solar position](#1-solar-position) ·
[clear sky](#2-clear-sky-irradiance) ·
[beam/diffuse split](#3-beam-and-diffuse-split) ·
[transposition](#4-plane-of-array-transposition) ·
[synthetic weather](#5-synthetic-weather) ·
[PVGIS files](#6-pvgis-files) · [panel](#7-panel-output) ·
[charger](#8-charger) · [load and regulator](#9-load-profile-and-regulator) ·
[battery](#10-battery) · [simulation](#11-hourly-simulation) ·
[sizer](#12-sizer) · [checks against references](#13-checks-against-published-values-and-data) ·
[references](#references)

## 1. Solar position

`src/core/solar.js` implements the equations of the NOAA Solar Calculator
spreadsheet [1], which are the low-precision algorithms of Meeus [2]. With
`T` the Julian centuries since J2000.0:

```
L0  = 280.46646 + T (36000.76983 + 0.0003032 T)            geometric mean longitude
M   = 357.52911 + T (35999.05029 - 0.0001537 T)            mean anomaly
e   = 0.016708634 - T (0.000042037 + 0.0000001267 T)       orbit eccentricity
C   = sin M (1.914602 - T (0.004817 + 0.000014 T))
    + sin 2M (0.019993 - 0.000101 T) + 0.000289 sin 3M     equation of centre
lam = L0 + C - 0.00569 - 0.00478 sin(125.04 - 1934.136 T)  apparent longitude
eps = eps0(T) + 0.00256 cos(125.04 - 1934.136 T)           corrected obliquity
dec = asin(sin eps sin lam)                                declination
y   = tan^2(eps / 2)
EoT = 4 (y sin 2L0 - 2e sin M + 4ey sin M cos 2L0
         - y^2/2 sin 4L0 - 5/4 e^2 sin 2M)   [rad -> deg]  equation of time, min
TST = UTC minutes + EoT + 4 lon                            true solar time
H   = TST / 4 - 180                                        hour angle
cos z = sin(lat) sin(dec) + cos(lat) cos(dec) cos(H)
```

Azimuth is measured clockwise from north. NOAA's refraction approximation
is available (used only in the reference test). NOAA quotes the method as
accurate to about one arc-minute for dates between 1800 and 2100; that is
far below anything that matters for hourly energy.

## 2. Clear-sky irradiance

Haurwitz global horizontal irradiance [3], in the form evaluated by Reno,
Hansen and Stein [4]:

```
GHI_clear = 1098 cos(z) exp(-0.059 / cos(z))     for cos(z) > 0, else 0   (W/m^2)
```

It needs only the zenith angle: no turbidity, water vapour or altitude.
Reno et al. found it to be among the better simple models for GHI, but it
is still a single curve for every site; aerosol-heavy air (for example
north Indian winter haze) and high altitude both move the real clear-sky
level. In this tool the cloudiness factor of each preset is fitted
_relative to_ Haurwitz, so a systematic offset at the fitting site is
absorbed into the factor (section 5). A turbidity-aware model such as
Ineichen-Perez [5] is not implemented.

Each simulated hour averages four sun positions (at :07.5, :22.5, :37.5
and :52.5) so that sunrise and sunset hours get a partial value.

## 3. Beam and diffuse split

The synthetic weather only produces global horizontal irradiance, so it is
split with the Erbs, Klein and Duffie correlation [6] on the clearness
index `kt = GHI / (I0 cos z)`, with `I0 = 1367 (1 + 0.033 cos(2 pi n / 365))`
W/m^2 [7]:

```
kt <= 0.22:        DHI/GHI = 1 - 0.09 kt
0.22 < kt <= 0.80: DHI/GHI = 0.9511 - 0.1604 kt + 4.388 kt^2 - 16.638 kt^3 + 12.336 kt^4
kt > 0.80:         DHI/GHI = 0.165
DNI = (GHI - DHI) / cos z
```

Because the cloud factor lowers `kt`, cloudy hours automatically become
mostly diffuse. Within about 0.5 deg of the horizon all light is treated as
diffuse.

## 4. Plane-of-array transposition

Isotropic sky (Liu and Jordan, as given in Duffie and Beckman [7]):

```
POA = DNI cos(theta) IAM(theta) + DHI (1 + cos beta)/2 + GHI rho (1 - cos beta)/2
cos(theta) = cos z cos beta + sin z sin beta cos(sun azimuth - panel azimuth)
IAM = 1 - b0 (1/cos(theta) - 1),  b0 = 0.05, floored at 0      (ASHRAE form)
```

`beta` is the tilt, `rho` the ground albedo (default 0.2). The isotropic
model ignores circumsolar brightening and horizon brightening, so it
typically under-estimates plane-of-array irradiance on tilted panels in
clear weather by a few percent compared with anisotropic models such as
Perez or Hay-Davies. Shading by buildings, trees or the enclosure is not
modelled.

## 5. Synthetic weather

`src/core/weather.js`. **Illustrative.** For each day `d` a clear-sky index
`k_d` multiplies the Haurwitz GHI for the whole day:

```
z_0 ~ N(0, 1),  z_d = phi z_{d-1} + sqrt(1 - phi^2) eps_d,  eps_d ~ N(0, 1)
k_d = clamp(mean_m + std_m z_d, 0.03, 1.1) x cloudScale
```

`mean_m` and `std_m` are per month, `phi` is the day-to-day persistence.
The generator is mulberry32 with a Box-Muller transform, so a seed gives the
same year on every platform.

Air temperature is the monthly mean (linearly interpolated between
mid-month points) plus a cosine daily cycle with the month's mean half range,
peaking at 15:00 local time.

**Where the preset numbers come from.** `scripts/fit-climate.js` reads a
PVGIS hourly file for a horizontal plane and computes, per month, the ratio
of measured to Haurwitz GHI (sum over the month), the standard deviation of
the daily ratio, the mean air temperature and the mean half diurnal range,
plus the lag-1 autocorrelation of the daily anomalies. The presets were
fitted this way to **one year (2020)** of PVGIS hourly data at each named
place (PVGIS-ERA5 for the Indian cities, PVGIS-SARAH3 for Nairobi and
Berlin). One year is not a climatology: the monsoon onset, the number of
overcast days and heat waves vary a lot from year to year, and real weeks
have intra-day variation that a single daily factor does not reproduce. The
"monsoon" behaviour in the Indian presets is just what 2020 looked like at
that grid cell. The "always clear" preset is hand-set and is an upper
bound, not a real climate. No PVGIS data is stored in this repository;
only these derived monthly statistics are.

Use the presets to explore and compare designs. For a decision about a
specific site, download PVGIS data for that site (section 6) and, ideally,
try several years.

## 6. PVGIS files

PVGIS (Photovoltaic Geographical Information System) is a free tool of the
European Commission's Joint Research Centre [8]. Its radiation databases
cover Europe, Africa, most of Asia including India, and the Americas.
The browser app and the CLI read the CSV files it produces; they never
contact PVGIS themselves.

**Hourly data** (web tool tab "Hourly data", or API `seriescalc`): metadata
lines, then `Slope: 15 deg.` and `Azimuth: 0 deg.`, then a header:

```
time,G(i),H_sun,T2m,WS10m,Int                          (radiation only)
time,P,Gb(i),Gd(i),Gr(i),H_sun,T2m,WS10m,Int           (with PV power and components)
20200101:0030,0.0,0.0,18.14,2.07,0.0
...
(blank line, legend lines, "PVGIS (c) European Union, 2001-20xx")
```

`G(i)` (or `Gb(i) + Gd(i) + Gr(i)`) is already the irradiance on the
inclined plane, so tilt and azimuth are taken from the file. PVGIS
azimuth is 0 = south, 90 = west, -90 = east; this tool uses degrees
clockwise from north, so `azimuth = PVGIS + 180`. `T2m` is the air
temperature used for the panel temperature and the battery.

**TMY** (tab "TMY", API `tmy`): header
`time(UTC),T2m,RH,G(h),Gb(n),Gd(h),IR(h),WS10m,WD10m,SP` and an
`Irradiance Time Offset (h)` line. The components are transposed to the
panel settings with section 4 at the row time plus the offset. A TMY
stitches months from different years; it is re-timed as one continuous
non-leap year.

Times are UTC. Rows are shifted by the time zone rounded to whole hours
(India's +5:30 becomes +6, so hourly values may be up to 30 minutes off),
and the few hours that fall off one end wrap to the other. Multi-year files
are simulated end to end.

The parser accepts Windows line endings and a byte-order mark, skips
unreadable lines before the data, stops at the legend, replaces unreadable
values (irradiance 0, temperature 25 degC) with a warning, and rejects files
whose rows are not consecutive hours.

## 7. Panel output

```
Tc = Ta + POA (NOCT - 20) / 800                                    (NOCT model [7])
P  = Wp (POA / 1000) (1 + gamma (Tc - 25)) (1 - soiling) (1 - otherLosses)
```

Defaults: gamma = -0.4 %/K (typical crystalline silicon), NOCT 48 degC
(small encapsulated panels in an enclosure often run hotter than framed
modules), soiling 5 %, other losses 10 % (wiring, mismatch, rating
tolerance; PVGIS uses 14 % as its default for whole systems [8]). Low-light
efficiency loss, spectral effects, partial shading and the gap between a
cheap panel's label and its real output are not modelled separately;
"other losses" is the place to account for them.

## 8. Charger

- **MPPT**: `P_out = min(P x eta, I_limit x Vbat)`.
- **Linear or PWM** (TP4056-style, or a panel switched straight onto the
  battery): the panel is pulled down to about the battery voltage, so the
  current is roughly the maximum-power current `P / Vmp`:
  `P_out = min((P / Vmp) eta Vbat, I_limit Vbat)`. With a 6 V panel on a
  3.7 V cell about 38 % of the panel's maximum power is lost before the
  battery. The model assumes the panel voltage stays above the battery
  voltage plus the charger's dropout; a warning is shown when Vmp is too
  close to the full battery voltage.

The battery then limits what it accepts (section 10).

## 9. Load profile and regulator

Each state has a current at the regulated supply (or at the battery when
there is no regulator). A scheduled state runs `duration` seconds every
`every` seconds, optionally only between local hours `from` and `to`. The
base state (normally sleep) fills the rest of each hour. If scheduled
states add up to more than the hour they are scaled down with a warning.

Battery power, for battery voltage `Vb`:

```
none:       P = Vb sum(share_i I_i)
LDO:        P = Vb (sum(share_i I_i) + Iq)
switching:  P = sum(share_i I_i Vout / eta(I_i)) + Vb Iq
```

The switching efficiency curve is interpolated in log(current) per state, so
a converter that is efficient at 100 mA but poor at 10 uA is charged
correctly for the sleep current. The node keeps running down to:

```
LDO:        Vb >= min(Vout, node minimum) + dropout     (in dropout the output follows the input)
switching:  Vb >= stated minimum input
none:       Vb >= node minimum supply
```

Presets: an MCP1700-class low-Iq LDO (1.6 uA quiescent, 0.178 V typical
dropout [10]); an AMS1117-class LDO as found on many ESP32 dev boards
(about 5 mA ground current and 1.1 V dropout [11]); and illustrative buck
and buck-boost curves. The peak battery current of any state is checked
against the chemistry's discharge-rate limit (section 10).

Not modelled: start-up inrush, brown-out detector behaviour, regulator
efficiency changing with input voltage, and voltage sag under load.

## 10. Battery

An energy bucket of `capacity x cells x nominal cell voltage` Wh.

| Preset                  | Nominal | Charge eff. | Self-discharge /month | Charge rate | Taper from | Peak discharge | Cold loss /K below 20 degC |
| ----------------------- | ------- | ----------- | --------------------- | ----------- | ---------- | -------------- | -------------------------- |
| Li-ion (NMC/LCO)        | 3.7 V   | 95 %        | 3 %                   | 0.5 C       | 80 %       | 2 C            | 0.8 %                      |
| LiFePO4                 | 3.2 V   | 96 %        | 3 %                   | 1 C         | 90 %       | 3 C            | 1.0 %                      |
| NiMH standard           | 1.2 V   | 75 %        | 20 %                  | 0.1 C       | 90 %       | 1 C            | 0.6 %                      |
| NiMH low self-discharge | 1.2 V   | 75 %        | 1.5 %                 | 0.1 C       | 90 %       | 1 C            | 0.6 %                      |

These are round, illustrative figures in the ranges given by Battery
University [12] and the Linden handbook [13]; real cells vary by maker,
age and temperature.

- **Usable window.** The floor is the highest of `1 - depth of discharge`,
  the state of charge at the cut-off voltage and the state of charge at the
  regulator's minimum input. Voltages are converted with a coarse
  open-circuit-voltage table per chemistry (no sag under load).
- **Cold.** Below 20 degC a fraction `coldLoss x (20 - T)` of the usable
  window (never more than 70 %) is unavailable: the floor rises. The energy
  is not lost; it is available again when it warms up. Battery temperature
  is taken as the air temperature (no enclosure heating or cooling).
- **Charging window.** No charging below 0 degC or above 45 degC (the usual
  limits for lithium cells [12]).
- **Charge acceptance.** Constant up to `C-rate x capacity x Vb`; above
  `taperFrom` it falls linearly to 5 % at full, approximating the
  constant-voltage phase. Within each hour the charge is integrated exactly:
  `dE/dt = eta min(P_offer, k taper(E))` (constant power, then an
  exponential approach along the linear taper). Solving it inside the hour
  keeps the result monotonic in the starting charge; holding the hour's
  starting acceptance would overshoot.
- **Self-discharge** removes `1 - (1 - m)^(1/730)` of the stored energy per
  hour for a monthly figure `m`. It does not depend on temperature here.
- **Discharge efficiency** is folded into the charge efficiency.

## 11. Hourly simulation

`src/core/simulate.js`. Each hour, in this order:

1. self-discharge;
2. the battery voltage from the open-circuit table at the hour's start;
3. charger output (section 8) and battery acceptance (section 10);
4. if the node is up, its load for the hour; charging is integrated from
   the charge left after the load;
5. if the result would be below the floor, the node runs for the fraction
   of the hour the energy covers and then browns out;
6. a node that is down draws nothing and restarts once the battery is back
   above `floor + restartFraction x usable window` (default 5 %), which
   stands in for an under-voltage lockout's hysteresis.

By default the year is simulated once as a warm-up starting full, and the
reported year starts from where the warm-up ended, so the result does not
depend on the starting charge.

Reported: panel energy, charger output, energy accepted and stored, charge
loss, clipped energy (offered but not accepted because the battery was full
or rate- or temperature-limited), energy delivered, unserved energy while
down, self-discharge, downtime hours and outages, lowest charge,
**days of autonomy** (defined below) and the **worst consecutive-days deficit**: the largest
running total of `load - storable harvest` over consecutive days,
`d = max(0, d + load_day - eta x charger output_day)`, which is the usable
energy an ideal, never-full battery would have needed.

**Days of autonomy** is how long a full battery keeps the node up with no
harvest at all, at 20 degC or above (no cold derating, so the floor is
`socMin x capacity`). It applies the same per-hour order as the
simulation: self-discharge removes a fraction `s` of the stored energy,
then the load takes `p`, the mean hourly load at the nominal voltage
(regulator quiescent current and conversion loss included). After `k`
whole hours from full energy `E0`

    E_k = (E0 + p/s) (1 - s)^k - p/s        (s > 0)
    E_k = E0 - k p                          (s = 0)

The result is the last whole hour `N` with `E_N >= floor` plus the fraction
`((1 - s) E_N - floor) / p` of the next hour, the same split the
simulation uses for the hour in which the node browns out. With no
self-discharge this reduces to `usable energy / daily load`. Because
self-discharge is proportional to the stored energy, it costs most while
the battery is full: for the bundled ESP32 example (9.25 Wh Li-ion, 3 %
a month, 56.5 mWh a day, 7.4 Wh usable) the leak starts near 9 mWh a day
and ends near 2 mWh a day, and autonomy is 119 days rather than the
131 days of usable energy over load. With no load the node never runs out
and autonomy is reported as infinite. Versions up to 0.1.0 reported
`usable / daily load` and so overstated autonomy whenever self-discharge
was non-zero.

The figure ignores the open-circuit-voltage dependence of the load (an LDO
or a direct supply draws `V x I`, which is above the nominal-voltage figure
for most of a lithium discharge), so a no-sun run in the full simulation
can end a few percent earlier; with a voltage-independent load the two
agree exactly (tested).

Energy balance holds to rounding: `stored - delivered - self-discharge =
end energy - start energy` (tested). The hourly step cannot see events
shorter than an hour except through the duty-cycle average; peak currents
are only checked against the battery's rate limit.

## 12. Sizer

`src/core/sizer.js` simulates every combination of a panel grid and a
battery grid (a full year each, with the warm-up). By default the grids are
chosen from the load: panels from a quarter to eight times
`daily load / (3 h x 50 %)`, batteries from half a day to 40 days of
autonomy, rounded to 1-1.5-2-3-5-7.5 steps, and never below the capacity
whose discharge-rate limit covers the peak current. Explicit grids can be
given in the configuration.

A combination meets the target when its downtime is at most the allowed
hours per year. The **frontier** keeps, for each panel size, the smallest
battery that meets the target, dropping points dominated by a smaller
panel with a smaller-or-equal battery. **Lowest cost** uses the relative
weights per Wp and per Ah.

**Monotonicity.** More panel never increased downtime in any test
(three climates, the examples). More battery is monotonic when
self-discharge and the restart margin are zero (tested). With them, a
bigger battery can show slightly _more_ downtime when the panel is far too
small: it leaks more energy in absolute terms and needs more charge to
clear the restart margin. That is a real effect, not a solver artefact, and
it is why the sizer simulates the whole grid instead of searching along a
line.

## 13. Checks against published values and data

- **Solar position** (tests/solar.test.js): Meeus example 25.a / 28.b
  (1992 October 13.0): declination -7.78507 deg (ours -7.78507), apparent
  longitude 199.90988 deg (ours 199.90894), equation of time 13.7094 min
  (ours 13.7109). NREL SPA worked example [9] (2003-10-17 12:30:30 UTC-7,
  39.742476 N, 105.1786 W): zenith 50.11162 deg and azimuth 194.34024 deg;
  ours 50.1086 deg and 194.3426 deg with refraction.
- **Synthetic vs PVGIS, one site.** Bengaluru (12.972 N, 77.594 E), panel
  at 15 deg facing south, plane-of-array irradiation in kWh/m^2. PVGIS
  values are from the PVGIS 5.3 API (PVGIS-ERA5, 2020, and the TMY),
  computed locally and not stored in the repository:

  | Source                             | Year total | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
  | ---------------------------------- | ---------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | PVGIS hourly 2020 (G(i))           | 1954       | 200 | 205 | 212 | 196 | 186 | 134 | 125 | 125 | 123 | 153 | 142 | 155 |
  | PVGIS TMY, transposed by this tool | 1966       | 204 | 201 | 214 | 201 | 185 | 132 | 116 | 118 | 137 | 145 | 143 | 170 |
  | Synthetic preset, seed 1           | 1943       | 199 | 196 | 216 | 198 | 190 | 130 | 145 | 127 | 122 | 144 | 129 | 147 |

  Seeds 2 and 3 give 1958 and 1873 kWh/m^2. This is a consistency check of
  the fitting at the site the preset was fitted to (and of the
  transposition, against PVGIS's own), not an independent validation; other
  places and other years will differ more.

- **Not checked**: anything against a physical node. No battery voltage,
  current or state-of-charge measurement from real hardware has been
  compared with this simulation.

## References

1. NOAA Global Monitoring Laboratory, _Solar Calculation Details_ and the
   NOAA Solar Calculator spreadsheets,
   https://gml.noaa.gov/grad/solcalc/calcdetails.html
2. J. Meeus, _Astronomical Algorithms_, 2nd ed., Willmann-Bell, 1998
   (chapters 25 and 28, examples 25.a and 28.b).
3. B. Haurwitz, "Insolation in relation to cloudiness and cloud density",
   _Journal of Meteorology_ 2 (1945) 154-166.
4. M. J. Reno, C. W. Hansen, J. S. Stein, _Global Horizontal Irradiance
   Clear Sky Models: Implementation and Analysis_, Sandia report
   SAND2012-2389, 2012.
5. P. Ineichen, R. Perez, "A new airmass independent formulation for the
   Linke turbidity coefficient", _Solar Energy_ 73 (2002) 151-157.
6. D. G. Erbs, S. A. Klein, J. A. Duffie, "Estimation of the diffuse
   radiation fraction for hourly, daily and monthly-average global
   radiation", _Solar Energy_ 28 (1982) 293-302.
7. J. A. Duffie, W. A. Beckman, _Solar Engineering of Thermal Processes_,
   4th ed., Wiley, 2013 (chapters 1, 2 and 23: extraterrestrial radiation,
   isotropic-sky tilted-surface model, NOCT cell temperature).
8. European Commission, Joint Research Centre, _PVGIS_,
   https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en,
   interactive tool https://re.jrc.ec.europa.eu/pvg_tools/en/ and the
   non-interactive API (`seriescalc`, `tmy`) documented there. Data
   "PVGIS (c) European Union, 2001-2026".
9. I. Reda, A. Andreas, _Solar Position Algorithm for Solar Radiation
   Applications_, NREL/TP-560-34302, revised 2008.
10. Microchip, _MCP1700 Low Quiescent Current LDO_ datasheet (DS20001826).
11. Advanced Monolithic Systems, _AMS1117 1A Low Dropout Voltage Regulator_
    datasheet.
12. Battery University, articles BU-410 (charging at high and low
    temperatures), BU-409 (charging lithium-ion), BU-802b (elevated
    self-discharge), https://batteryuniversity.com/
13. T. B. Reddy (ed.), _Linden's Handbook of Batteries_, 4th ed.,
    McGraw-Hill, 2011.
