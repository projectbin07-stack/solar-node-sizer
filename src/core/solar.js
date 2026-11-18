// Solar geometry and irradiance on a tilted panel.
//
// Sun position: the NOAA solar calculator equations (low-precision Meeus
// algorithms, good to about 0.01 deg in declination for 1800-2100).
// Clear-sky irradiance: Haurwitz global horizontal model.
// Beam/diffuse split: Erbs, Klein and Duffie (1982) correlation.
// Transposition: isotropic sky (Liu and Jordan), ground albedo, and the
// ASHRAE incidence-angle modifier on the beam component.
// References and accuracy limits are in docs/models.md.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Solar constant used with the Erbs correlation, W/m^2. */
export const SOLAR_CONSTANT = 1367;

/**
 * Julian day from a Unix time in milliseconds (UTC).
 * @param {number} ms
 * @returns {number}
 */
export function julianDay(ms) {
  return ms / 86400000 + 2440587.5;
}

/**
 * @typedef {object} SunTerms
 * @property {number} declination Apparent declination, degrees.
 * @property {number} eqTime Equation of time, minutes (true minus mean solar time).
 * @property {number} apparentLongitude Apparent ecliptic longitude, degrees.
 */

/**
 * Declination and equation of time for a Julian day (NOAA spreadsheet terms).
 * @param {number} jd Julian day (UT; the difference to TT is ignored).
 * @returns {SunTerms}
 */
export function sunTerms(jd) {
  const t = (jd - 2451545) / 36525; // Julian centuries since J2000.0
  const l0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliqMean = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = obliqMean + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD)) * DEG;
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  return { declination, eqTime, apparentLongitude: mod(appLong, 360) };
}

/**
 * Atmospheric refraction correction (NOAA approximation), degrees, to add to
 * the geometric elevation.
 * @param {number} elevation geometric elevation, degrees
 * @returns {number}
 */
export function refraction(elevation) {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let arcsec;
  if (elevation > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575)
    arcsec =
      1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else arcsec = -20.772 / te;
  return arcsec / 3600;
}

/**
 * @typedef {object} SunPosition
 * @property {number} zenith degrees, refraction-corrected if requested
 * @property {number} azimuth degrees clockwise from north (180 = south)
 * @property {number} elevation 90 - zenith
 * @property {number} declination degrees
 * @property {number} eqTime minutes
 * @property {number} hourAngle degrees, negative before solar noon
 */

/**
 * Sun position for an instant and a place.
 * @param {number} ms Unix time in milliseconds (UTC)
 * @param {number} lat latitude, degrees north
 * @param {number} lon longitude, degrees east
 * @param {boolean} [refract] apply the refraction correction (default false)
 * @returns {SunPosition}
 */
export function sunPosition(ms, lat, lon, refract = false) {
  const { declination, eqTime } = sunTerms(julianDay(ms));
  const minutesUtc = mod(ms / 60000, 1440);
  const trueSolarTime = mod(minutesUtc + eqTime + 4 * lon, 1440);
  const hourAngle = trueSolarTime / 4 - 180;
  const latR = lat * RAD;
  const decR = declination * RAD;
  const cosZ = clamp(
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(hourAngle * RAD),
    -1,
    1,
  );
  const zenithGeo = Math.acos(cosZ) * DEG;
  const sinZ = Math.sin(zenithGeo * RAD);
  let azimuth;
  const denom = Math.cos(latR) * sinZ;
  if (Math.abs(denom) < 1e-12) {
    azimuth = lat >= 0 ? 180 : 0; // sun at the zenith or observer at a pole
  } else {
    const a = Math.acos(clamp((Math.sin(latR) * cosZ - Math.sin(decR)) / denom, -1, 1)) * DEG;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  let elevation = 90 - zenithGeo;
  if (refract) elevation += refraction(elevation);
  return { zenith: 90 - elevation, azimuth, elevation, declination, eqTime, hourAngle };
}

/**
 * Extraterrestrial normal irradiance (Spencer-style cosine form, Duffie and Beckman eq. 1.4.1a).
 * @param {number} dayOfYear 1..366
 * @returns {number} W/m^2
 */
export function extraterrestrialNormal(dayOfYear) {
  return SOLAR_CONSTANT * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
}

/**
 * Haurwitz clear-sky global horizontal irradiance.
 * GHI = 1098 cos(z) exp(-0.059 / cos(z)), zero with the sun below the horizon.
 * @param {number} zenith degrees
 * @returns {number} W/m^2
 */
export function haurwitzGhi(zenith) {
  const cz = Math.cos(zenith * RAD);
  if (cz <= 0) return 0;
  return 1098 * cz * Math.exp(-0.059 / cz);
}

/**
 * Erbs diffuse fraction of global horizontal irradiance as a function of the
 * clearness index kt = GHI / (I0 cos z).
 * @param {number} kt
 * @returns {number} DHI / GHI
 */
export function erbsDiffuseFraction(kt) {
  if (kt <= 0.22) return 1 - 0.09 * Math.max(0, kt);
  if (kt <= 0.8)
    return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

/**
 * @typedef {object} PanelGeometry
 * @property {number} tilt degrees from horizontal
 * @property {number} azimuth degrees clockwise from north the panel faces (180 = south)
 * @property {number} [albedo] ground reflectance (default 0.2)
 */

/**
 * Cosine of the angle of incidence of the beam on the panel.
 * @param {number} zenith sun zenith, degrees
 * @param {number} sunAzimuth degrees clockwise from north
 * @param {number} tilt degrees
 * @param {number} panelAzimuth degrees clockwise from north
 * @returns {number} may be negative (sun behind the panel)
 */
export function cosIncidence(zenith, sunAzimuth, tilt, panelAzimuth) {
  const z = zenith * RAD;
  const b = tilt * RAD;
  return (
    Math.cos(z) * Math.cos(b) +
    Math.sin(z) * Math.sin(b) * Math.cos((sunAzimuth - panelAzimuth) * RAD)
  );
}

/**
 * ASHRAE incidence-angle modifier, 1 - b0 (1/cos(theta) - 1), floored at 0.
 * @param {number} cosTheta
 * @param {number} [b0] default 0.05
 * @returns {number}
 */
export function iamAshrae(cosTheta, b0 = 0.05) {
  if (cosTheta <= 0) return 0;
  return Math.max(0, 1 - b0 * (1 / cosTheta - 1));
}

/**
 * @typedef {object} PlaneIrradiance
 * @property {number} poa total plane-of-array irradiance, W/m^2
 * @property {number} beam
 * @property {number} sky
 * @property {number} ground
 * @property {number} dhi diffuse horizontal used
 * @property {number} dni direct normal used
 */

/**
 * Split GHI into beam and diffuse with Erbs and transpose to the panel plane
 * with the isotropic sky model.
 * @param {number} ghi W/m^2
 * @param {number} zenith degrees
 * @param {number} sunAzimuth degrees
 * @param {number} dayOfYear 1..366
 * @param {PanelGeometry} panel
 * @returns {PlaneIrradiance}
 */
export function transpose(ghi, zenith, sunAzimuth, dayOfYear, panel) {
  const cz = Math.cos(zenith * RAD);
  if (ghi <= 0 || cz <= 0.0087) {
    // Below about 89.5 deg zenith all light is treated as diffuse.
    const g = Math.max(0, ghi);
    return transposeComponents(g, 0, g, zenith, sunAzimuth, panel);
  }
  const i0h = extraterrestrialNormal(dayOfYear) * cz;
  const kt = Math.min(1, ghi / i0h);
  const dhi = ghi * erbsDiffuseFraction(kt);
  const dni = (ghi - dhi) / cz;
  return transposeComponents(ghi, dni, dhi, zenith, sunAzimuth, panel);
}

/**
 * Isotropic-sky transposition of known components: beam (with the ASHRAE
 * incidence-angle modifier), sky diffuse and ground-reflected.
 * @param {number} ghi global horizontal, W/m^2
 * @param {number} dni direct normal, W/m^2
 * @param {number} dhi diffuse horizontal, W/m^2
 * @param {number} zenith degrees
 * @param {number} sunAzimuth degrees
 * @param {PanelGeometry} panel
 * @returns {PlaneIrradiance}
 */
export function transposeComponents(ghi, dni, dhi, zenith, sunAzimuth, panel) {
  const albedo = panel.albedo ?? 0.2;
  const tiltR = panel.tilt * RAD;
  const ct = zenith < 90 ? cosIncidence(zenith, sunAzimuth, panel.tilt, panel.azimuth) : 0;
  const beam = ct > 0 ? dni * ct * iamAshrae(ct) : 0;
  const sky = (dhi * (1 + Math.cos(tiltR))) / 2;
  const ground = (ghi * albedo * (1 - Math.cos(tiltR))) / 2;
  return { poa: beam + sky + ground, beam, sky, ground, dhi, dni };
}

/**
 * Day of year (1..366) of a UTC instant shifted by a time zone.
 * @param {number} ms
 * @param {number} tz hours east of UTC
 * @returns {number}
 */
export function dayOfYear(ms, tz = 0) {
  const d = new Date(ms + tz * 3600000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

/**
 * @param {number} x
 * @param {number} m
 * @returns {number}
 */
function mod(x, m) {
  return ((x % m) + m) % m;
}

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
