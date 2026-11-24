import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, normalizeConfig } from "../src/core/config.js";
import { EXAMPLES } from "../src/core/examples.js";
import {
  decodeLoad,
  decodeState,
  encodeLoad,
  encodeState,
  importConfigText,
  num,
} from "../src/ui/state.js";
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

test("importing an embedded-power-profiler load export changes only the load (audit #23)", () => {
  const current = normalizeConfig(EXAMPLES[1].config);
  const text = readFileSync("tests/fixtures/epp-export-load.json", "utf8");
  const r = importConfigText(text, current);
  assert.equal(r.loadOnly, true);
  assert.deepEqual(r.replaced, ["load"]);
  assert.equal(r.config.load.length, 5);
  assert.deepEqual(r.config.load[3], {
    name: "Wi-Fi connect",
    mA: 94.9105,
    every: 60,
    duration: 2.79867,
  });
  assert.equal(r.config.name, "synth.log (measured)");
  assert.match(r.config.note, /embedded-power-profiler/);
  // everything else is the page's current setup
  assert.deepEqual(r.config.location, current.location);
  assert.deepEqual(r.config.battery, current.battery);
  assert.deepEqual(r.config.regulator, current.regulator);
  assert.equal(r.config.regulatorPreset, current.regulatorPreset);
  // the same file read by the CLI path gives the same load
  assert.deepEqual(r.config.load, normalizeConfig(JSON.parse(text)).load);
});

test("importing a full configuration matches what the CLI reads", () => {
  const text = readFileSync("tests/fixtures/epp-export-full.json", "utf8");
  const r = importConfigText(text, normalizeConfig(EXAMPLES[1].config));
  assert.equal(r.loadOnly, false);
  assert.deepEqual(r.config, normalizeConfig(JSON.parse(text)));
  // with a byte-order mark too
  assert.deepEqual(importConfigText("﻿" + text, defaultConfig()).config, r.config);
});

test("importing: a regulator without a preset is custom, a preset alone takes its parameters", () => {
  const cur = defaultConfig();
  const custom = importConfigText(
    JSON.stringify({ regulator: { type: "ldo", vout: 3.0, iqUa: 2, dropout: 0.2 } }),
    cur,
  ).config;
  assert.equal(custom.regulatorPreset, "custom");
  assert.equal(custom.regulator.vout, 3.0);
  const buck = importConfigText(JSON.stringify({ regulatorPreset: "buck" }), custom).config;
  assert.equal(buck.regulatorPreset, "buck");
  assert.equal(buck.regulator.type, "switching");
  assert.deepEqual(importConfigText("{}", cur).config, cur);
});

test("importing rejects files that are not configurations", () => {
  const cur = defaultConfig();
  assert.throws(() => importConfigText("not json", cur), /not valid JSON/);
  assert.throws(() => importConfigText("[1,2]", cur), /JSON object/);
  assert.throws(() => importConfigText('{"bogus": 1}', cur), /unknown field bogus/);
  assert.throws(() => importConfigText('{"load": []}', cur), /non-empty array/);
});
