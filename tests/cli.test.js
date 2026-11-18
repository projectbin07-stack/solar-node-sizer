import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION, main } from "../src/cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Run the CLI in memory; files are read from the repository.
 * @param {string[]} argv
 * @returns {{code: number, out: string, err: string, files: Record<string, string>}}
 */
function cli(argv) {
  let out = "";
  let err = "";
  /** @type {Record<string, string>} */
  const files = {};
  const code = main(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    readFile: (p) => readFileSync(new URL(p, new URL("../", import.meta.url)), "utf8"),
    writeFile: (p, d) => (files[p] = d),
  });
  return { code, out, err, files };
}

test("--version and --help", () => {
  assert.equal(cli(["--version"]).out, `${VERSION}\n`);
  const help = cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /simulate <config.json>/);
  assert.match(cli([]).out, /Usage:/);
});

test("simulate --json has the documented shape and is deterministic", () => {
  const a = cli(["simulate", "examples/esp32-wifi-10min.json", "--json"]);
  assert.equal(a.code, 0, a.err);
  const j = JSON.parse(a.out);
  assert.equal(typeof j.summary, "string");
  assert.equal(j.resource.kind, "synthetic");
  assert.equal(j.months.length, 12);
  assert.equal(j.budget.states.length, 3);
  assert.equal(typeof j.downtimeHours, "number");
  assert.equal(typeof j.autonomyDays, "number");
  for (const k of [
    "pv",
    "offered",
    "accepted",
    "stored",
    "chargeLoss",
    "clipped",
    "load",
    "unserved",
    "selfDischarge",
  ])
    assert.equal(typeof j.totalsWh[k], "number", k);
  assert.equal(cli(["simulate", "examples/esp32-wifi-10min.json", "--json"]).out, a.out);
  const other = JSON.parse(
    cli(["simulate", "examples/esp32-wifi-10min.json", "--json", "--seed", "2"]).out,
  );
  assert.notEqual(other.totalsWh.pv, j.totalsWh.pv);
});

test("simulate text output, overrides and CSV", () => {
  const r = cli([
    "simulate",
    "examples/atmega-nrf24.json",
    "--wp",
    "0.01",
    "--mah",
    "50",
    "--csv",
    "out.csv",
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /panel {8}0.01 Wp/);
  assert.match(r.out, /1S 50 mAh/);
  assert.match(r.out, /^result: /m);
  assert.equal(r.files["out.csv"].trim().split("\n").length, 8761);
});

test("simulate with a PVGIS file uses its tilt and azimuth", () => {
  const r = cli([
    "simulate",
    "examples/esp32-wifi-10min.json",
    "--pvgis",
    "tests/fixtures/pvgis-series-sample.csv",
    "--json",
  ]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.resource.kind, "pvgis-series");
  assert.equal(j.resource.tilt, 15);
  assert.equal(j.resource.azimuth, 150);
  assert.match(j.summary, /the 2 simulated days/);
});

test("size --json and text", () => {
  const r = cli(["size", "examples/esp32-devboard-ams1117.json", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.downtimeHours.length, j.panelWp.length);
  assert.equal(j.downtimeHours[0].length, j.batteryMah.length);
  assert.equal(j.peakLimited.length, j.batteryMah.length);
  assert.ok(Array.isArray(j.frontier) && j.frontier.length > 0);
  assert.equal(typeof j.best.wp, "number");
  assert.equal(j.runs, j.panelWp.length * j.batteryMah.length);
  const t = cli(["size", "examples/esp32-wifi-10min.json"]);
  assert.match(t.out, /downtime hours \(rows: panel Wp, columns: battery mAh\)/);
  assert.match(t.out, /^best {9}/m);
  assert.match(t.out, /peak/);
});

test("size reports when nothing in the grid works", () => {
  const r = cli(["size", "examples/esp32-wifi-10min.json", "--wp", "1"]);
  assert.equal(r.code, 0);
  const tiny = cli(["size", "tests/fixtures/impossible.json"]);
  assert.equal(tiny.code, 0, tiny.err);
  assert.match(tiny.out, /none: no combination in the grid meets the target/);
});

test("presets in text and JSON", () => {
  assert.match(cli(["presets"]).out, /bengaluru/);
  const j = JSON.parse(cli(["presets", "--json"]).out);
  assert.ok(j.cities.length >= 5 && j.climates.length >= 5 && j.chemistries.length >= 3);
});

test("usage and input errors exit with code 2 and a message", () => {
  /** @type {Array<[string[], RegExp]>} */
  const cases = [
    [["fly"], /unknown command/],
    [["simulate"], /needs a configuration file/],
    [["simulate", "a.json", "b.json"], /unexpected argument/],
    [["size", "examples/esp32-wifi-10min.json", "--csv", "x.csv"], /--csv only applies/],
    [["simulate", "examples/esp32-wifi-10min.json", "--wp", "lots"], /--wp must be a number/],
    [["simulate", "examples/esp32-wifi-10min.json", "--bogus"], /Unknown option/],
    [["simulate", "missing.json"], /file not found/],
    [["simulate", "tests/fixtures/pvgis-tmy-sample.csv"], /not valid JSON/],
    [
      ["simulate", "examples/esp32-wifi-10min.json", "--pvgis", "examples/atmega-nrf24.json"],
      /No data header/,
    ],
    [["simulate", "tests/fixtures/bad-config.json"], /panel.wp must be 0..1000/],
  ];
  for (const [argv, re] of cases) {
    const r = cli(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, re, argv.join(" "));
  }
});

test("the bin script runs as a separate process", () => {
  const r = spawnSync(process.execPath, ["bin/solar-node-sizer.js", "--version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
});
