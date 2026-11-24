// Headless-browser test of the configuration import (file picker and drag
// and drop), driven over the Chrome DevTools Protocol with no dependencies.
//
//   node scripts/serve.js &
//   node scripts/browser-import-test.js [path to chrome or msedge]
//
// The browser defaults to $CHROME, then google-chrome. It checks that an
// embedded-power-profiler export picked in the file input, or dropped on
// the page, changes the load and the results the page shows, and that a bad
// file is reported instead of applied.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserPath = process.argv[2] ?? process.env.CHROME ?? "google-chrome";
const pageUrl = process.env.PAGE_URL ?? "http://127.0.0.1:8000/";
const profile = mkdtempSync(join(process.env.TMP ?? tmpdir(), "sns-cdp-"));

const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let exited = "";
browser.stderr.on("data", (d) => (exited += String(d)));
browser.on("exit", (code) => (exited += ` [browser exited with ${code}]`));

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The browser writes its debugging port to DevToolsActivePort in the
 * profile (more reliable than parsing stderr, which Windows builds do not
 * always write to a pipe).
 * @returns {Promise<string>}
 */
async function debugPort() {
  for (let i = 0; i < 200; i++) {
    try {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\s+/)[0];
      if (port) return port;
    } catch {
      // not written yet
    }
    // (the Windows launcher can exit while the browser it started keeps running)
    await sleep(100);
  }
  throw new Error(`browser did not start: ${exited}`);
}

let failures = 0;
/**
 * @param {boolean} ok
 * @param {string} what
 */
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}

async function main() {
  const port = await debugPort();
  /** @type {Array<{type: string, webSocketDebuggerUrl: string}>} */
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let nextId = 0;
  /** @type {Map<number, {ok: (v: any) => void, fail: (e: Error) => void}>} */
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.fail(new Error(JSON.stringify(msg.error)));
    else p.ok(msg.result);
  };
  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++nextId;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /**
   * @param {string} expr
   * @returns {Promise<any>}
   */
  const evaluate = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))
      .result.value;
  /**
   * @param {string} expr
   * @param {string} what
   */
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(expr)) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for: ${what}`);
    return false;
  };
  const text = (/** @type {string} */ id) =>
    evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const ready = `document.getElementById("status").textContent === "ready"`;
  const load = async () => {
    await send("Page.navigate", { url: pageUrl });
    await waitFor(ready, "first simulation");
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");

  // 1. File picker: the load-only export onto the default ESP32 example.
  await load();
  const before = String(await text("tiles"));
  check(before.includes("119 days"), `default page autonomy 119 days (${before.slice(0, 80)}...)`);
  const doc = await send("DOM.getDocument");
  const node = await send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#config-file",
  });
  await send("DOM.setFileInputFiles", {
    nodeId: node.nodeId,
    files: [join(root, "tests", "fixtures", "epp-export-load.json")],
  });
  await waitFor(
    `document.getElementById("config-status").textContent.startsWith("Imported") && ${ready}`,
    "import via file picker",
  );
  const status1 = String(await text("config-status"));
  console.log(`  status: ${status1}`);
  check(status1.includes("load profile with 5 states"), "file picker: load-only import reported");
  const rows = await evaluate(`document.querySelectorAll("#load-rows tr").length`);
  check(rows === 5, `file picker: 5 load rows (got ${rows})`);
  const tiles1 = String(await text("tiles"));
  console.log(`  tiles: ${tiles1}`);
  // Same figures as `solar-node-sizer simulate tests/fixtures/epp-export-load.json`.
  check(tiles1.includes("Daily load512 mWh"), "file picker: daily load 512 mWh (CLI: 512 mWh/day)");
  check(tiles1.includes("14.3 days"), "file picker: autonomy 14.3 days (CLI: 14.3)");
  check(String(await text("config-note")).includes("embedded-power-profiler"), "note shown");

  // 2. Drag and drop: the full-config export, then a file that is not JSON.
  await load();
  /**
   * @param {string} name
   * @param {string} bodyExpr
   */
  const drop = (name, bodyExpr) =>
    evaluate(`(async () => {
      const body = ${bodyExpr};
      const dt = new DataTransfer();
      dt.items.add(new File([body], ${JSON.stringify(name)}, { type: "application/json" }));
      document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
  await drop("full.json", `await (await fetch("tests/fixtures/epp-export-full.json")).text()`);
  await waitFor(
    `document.getElementById("config-status").textContent.startsWith("Imported") && ${ready}`,
    "import via drop",
  );
  const status2 = String(await text("config-status"));
  console.log(`  status: ${status2}`);
  check(
    status2.startsWith("Imported full.json: location, panel"),
    "drop: full configuration applied",
  );
  check(String(await text("tiles")).includes("14.3 days"), "drop: autonomy 14.3 days");
  await drop("broken.json", `"{ not json"`);
  await waitFor(
    `document.getElementById("config-status").textContent.startsWith("Could not import")`,
    "bad file reported",
  );
  const status3 = String(await text("config-status"));
  console.log(`  status: ${status3}`);
  check(status3.includes("not valid JSON"), "drop: invalid JSON reported");
  check(String(await text("tiles")).includes("14.3 days"), "drop: bad file left the setup alone");

  ws.close();
}

try {
  await main();
} catch (e) {
  console.log(`FAIL ${/** @type {Error} */ (e).message}`);
  failures++;
} finally {
  browser.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // the browser may still hold the profile on Windows; it is a temp dir
  }
}
console.log(failures === 0 ? "browser import test passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
