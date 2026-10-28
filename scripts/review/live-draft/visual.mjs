/** Real-build evidence: only the selected real OPFS write is delayed. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { addCapabilities, sealWithPin } from "./lib/pages-journey.mjs";
import { openLive } from "./lib/live-join-walk.mjs";

const phase = process.env.DRAFT_PHASE;
const out = process.env.DRAFT_EVIDENCE;
if (!["before", "after"].includes(phase) || !out) throw new Error("Missing evidence phase/output");
fs.mkdirSync(out, { recursive: true });
const origin = "https://tyler-r-kendrick.github.io";
const base = "/OpenSesame/";
const harness = createHarness({ dist: path.resolve("dist"), origin, base, out });
const browser = await harness.launch();
const measurements = [];
const scenarios = [
  { name: "address", label: "Tailnet, VPN or LAN address", button: "Add the address", first: "100.64.0.1", second: "100.64.0.2" },
  { name: "server", label: "STUN or TURN server", button: "Add the server", first: "stun:first.example.com", second: "stun:next.example.com" },
  { name: "carrier", label: "Server (https://)", button: "Add the carrier", first: "https://first.example.com", second: "https://next.example.com" },
];
try {
  for (const width of [1366, 390]) {
    const device = { viewport: { width, height: width === 390 ? 844 : 900 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) };
    const { page, context } = await harness.newPage(browser, { device });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await addCapabilities(page, ["Live sessions"]);
    const { routes } = await openLive(page);
    // The fixture leaves all app logic and ciphertext intact. It delays only
    // the next real createWritable for the live-transport file, then allows
    // that same browser OPFS write/close to proceed. No bytes are inspected.
    await page.evaluate(() => {
      const proto = globalThis.FileSystemFileHandle?.prototype;
      if (!proto?.createWritable) throw new Error("OPFS write API unavailable");
      const original = proto.createWritable;
      const state = { armed: false, blocked: false, closed: false, timedOut: false, release: null };
      globalThis.__liveDraftEvidence = state;
      proto.createWritable = async function (...args) {
        if (!state.armed || !this.name.startsWith("opensesame-pages-tomb_") || !this.name.endsWith("_config_live-transport.json"))
          return original.apply(this, args);
        state.armed = false;
        state.blocked = true;
        await new Promise((resolve) => {
          const timer = setTimeout(() => { state.timedOut = true; resolve(); }, 15000);
          state.release = () => { clearTimeout(timer); resolve(); };
        });
        const writable = await original.apply(this, args);
        const close = writable.close.bind(writable);
        writable.close = async (...closeArgs) => {
          const result = await close(...closeArgs);
          state.closed = true;
          return result;
        };
        return writable;
      };
    });
    for (const scenario of scenarios) {
      const field = routes.getByLabel(scenario.label, { exact: true });
      const button = routes.getByRole("button", { name: scenario.button, exact: true });
      await field.scrollIntoViewIfNeeded();
      await field.fill("");
      await field.pressSequentially(scenario.first, { delay: 15 });
      await expect(button).toBeEnabled();
      await page.evaluate(() => {
        const state = globalThis.__liveDraftEvidence;
        state.armed = true; state.blocked = false; state.closed = false; state.timedOut = false; state.release = null;
      });
      await button.click();
      await page.waitForFunction(() => globalThis.__liveDraftEvidence.blocked, null, { timeout: 10000 });
      await field.fill("");
      await field.pressSequentially(scenario.second, { delay: 15 });
      await page.evaluate(() => globalThis.__liveDraftEvidence.release());
      await page.waitForFunction(() => globalThis.__liveDraftEvidence.closed, null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => globalThis.__liveDraftEvidence.timedOut), false);
      // Allow the real VFS index/registration writes and React completion after
      // the observed transport-file close; report this measurement honestly.
      await page.waitForTimeout(2000);
      await expect(field).toHaveValue(phase === "before" ? "" : scenario.second);
      await button.scrollIntoViewIfNeeded();
      const geometry = await field.evaluate((input) => {
        const r = input.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, valueLength: input.value.length };
      });
      const buttonGeometry = await button.evaluate((control) => {
        const r = control.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, disabled: control.disabled };
      });
      assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= device.viewport.height);
      assert.ok(buttonGeometry.y >= 0 && buttonGeometry.y + buttonGeometry.height <= device.viewport.height);
      measurements.push({ phase, width, scenario: scenario.name, geometry, buttonGeometry, observedTransportFileClose: true, secondsAfterClose: 2 });
      await page.screenshot({ path: path.join(out, `${phase}-${width}-${scenario.name}.png`) });
      // Complete the second real save: empty-after-success is the form's own
      // acknowledgement, and both actual saved rows must remain visible.
      if (phase === "before") await field.pressSequentially(scenario.second, { delay: 15 });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(field).toHaveValue("");
      await routes.getByText(scenario.first, { exact: true }).waitFor();
      await routes.getByText(scenario.second, { exact: true }).waitFor();
    }
    await context.close();
  }
  const errors = harness.log.filter((entry) => entry.kind === "PAGE-ERROR" || entry.kind === "LOOPBACK-REQUEST");
  if (errors.length) throw new Error(`Evidence harness observed ${errors.length} page/network errors`);
  fs.writeFileSync(path.join(out, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
} finally {
  await browser.close();
}
