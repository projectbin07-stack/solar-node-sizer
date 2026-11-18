import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, normalizeConfig } from "../src/core/config.js";
import { EXAMPLES } from "../src/core/examples.js";
import { decodeLoad, decodeState, encodeLoad, encodeState, num } from "../src/ui/state.js";
import { readFileSync } from "node:fs";

/**
 * @param {import("../src/core/config.js").Config} config
 * @returns {string}
 */
const enc = (config) => encodeState({ config, theme: "auto", example: null, ignored: [] });

test("the default configuration encodes to an empty query and back", () => {
  assert.equal(enc(defaultConfig()), "");
  const s = decodeState("");
  assert.deepEqual(s.config, defaultConfig());
  assert.equal(s.theme, "auto");
  assert.deepEqual(s.ignored, []);
});

test("every example survives a round trip through the URL", () => {
  for (const ex of EXAMPLES) {
    const c = normalizeConfig(ex.config);
    const q = encodeState({ config: c, theme: "dark", example: ex.id, ignored: [] });
    const back = decodeState(q);
    // name and note are not part of the link
    assert.deepEqual({ ...back.config, name: c.name, note: c.note }, c, ex.id);
    assert.equal(back.theme, "dark");
    assert.equal(back.example, ex.id);
  }
});

test("the examples module matches the JSON files used by the CLI", () => {
  for (const ex of EXAMPLES) {
    const file = JSON.parse(
      readFileSync(new URL(`../examples/${ex.id}.json`, import.meta.url), "utf8"),
    );
    assert.deepEqual(ex.config, file, ex.id);
  }
});

test("custom regulator, switching curve, grids and windows round-trip", () => {
  const c = defaultConfig();
  c.regulatorPreset = "custom";
  c.regulator = {
    type: "switching",
    vout: 3.0,
    iqUa: 2,
    dropout: 0,
    minVin: 2.5,
    nodeMinV: 2.8,
    efficiency: [
      [0.1, 0.7],
      [10, 0.9],
    ],
  };
  c.load = [
    { name: "sleep", mA: 0.004, base: true },
    { name: "camera; night~", mA: 250, every: 3600, duration: 20, from: 6, to: 18 },
  ];
  c.sizer.panelWp = [0.5, 1];
  c.sizer.batteryMah = [500, 1000];
  c.charger.type = "mppt";
  c.battery.chemistry = "nimh-lsd";
  c.location.climate = "berlin";
  const back = decodeState(enc(c)).config;
  assert.equal(back.load[1].name, "camera  night");
  back.load[1].name = c.load[1].name;
  assert.deepEqual(back, c);
});

test("a preset regulator with an edited field becomes custom", () => {
  const c = defaultConfig();
  c.regulator.iqUa = 4;
  const q = enc(c);
  assert.match(q, /riq=4/);
  const back = decodeState(q).config;
  assert.equal(back.regulator.iqUa, 4);
  assert.equal(back.regulatorPreset, "custom");
  const preset = decodeState("reg=buck").config;
  assert.equal(preset.regulator.type, "switching");
  const typeOnly = decodeState("rt=switching&reg=custom").config;
  assert.ok(typeOnly.regulator.efficiency.length > 0);
});

test("invalid parameters are ignored one by one", () => {
  const s = decodeState(
    "wp=abc&lat=200&mah=1500&ch=solar&chem=lead&reg=zzz&rt=x&L=bad&pw=1,-2&bm=&theme=neon&reff=1:x&cl=mars&rvo=",
  );
  assert.equal(s.config.battery.capacityMah, 1500);
  assert.equal(s.config.panel.wp, defaultConfig().panel.wp);
  assert.equal(s.theme, "auto");
  for (const k of ["wp", "lat", "ch", "chem", "reg", "rt", "L", "pw", "bm", "reff", "cl", "rvo"])
    assert.ok(s.ignored.includes(k), k);
});

test("load encoding", () => {
  const states = [
    { name: "s", mA: 0.01, base: true },
    { name: "tx", mA: 30, every: 60, duration: 0.1 },
  ];
  assert.equal(encodeLoad(states), "s~0.01~b;tx~30~60~0.1");
  assert.deepEqual(decodeLoad("s~0.01~b;tx~30~60~0.1"), states);
  assert.equal(decodeLoad("x~1"), null);
  assert.equal(decodeLoad("x~-1~b"), null);
  assert.equal(decodeLoad("x~1~5"), null);
  assert.equal(decodeLoad("x~1~5~1~3~nope"), null);
  assert.equal(decodeLoad("~~"), null);
  assert.equal(encodeLoad([{ name: "", mA: 1, base: true }]), "state~1~b");
  assert.equal(num(1 / 3), "0.333333");
});
