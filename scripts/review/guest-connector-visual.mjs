import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [phase, root, out] = process.argv.slice(2);
if (!["before", "after"].includes(phase)) throw new Error("Unknown phase");
fs.mkdirSync(out, { recursive: true });
const imp = (p) => import(pathToFileURL(path.join(root, p)));
const { createHarness } = await imp("apps/pages/scripts/lib/static-origin-harness.mjs");
const { sealWithPin, addCapabilities, lockVault, unlockWithPin } = await imp("apps/pages/scripts/lib/pages-journey.mjs");
const { doorGuest } = await imp("apps/pages/scripts/lib/front-door.mjs");
const { tabStep } = await imp("apps/pages/scripts/lib/capture-tab-step.mjs");
const origin = "https://tyler-r-kendrick.github.io";
const harness = createHarness({ dist: path.join(root, "apps/pages/dist"), origin, base: "/OpenSesame/", out });
const browser = await harness.launch({ args: ["--no-sandbox"] });
const results = [];
const visit = async (page, route) => page.evaluate((href) => {
  history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent("popstate"));
}, `/OpenSesame/${route}`);
try {
  for (const [label, width, height, touch] of [["phone", 390, 844, true], ["desktop", 1280, 900, false]]) {
    for (const session of ["guest", "genuine"]) {
      const { page, context } = await harness.newPage(browser, { device: { viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 } });
      try {
        await page.goto(`${origin}/OpenSesame/`, { waitUntil: "networkidle" });
        if (session === "guest") {
          await doorGuest(page).waitFor({ state: "visible", timeout: 15000 });
          await doorGuest(page).click();
          await page.locator(".unlock").waitFor({ state: "detached", timeout: 20000 });
        } else await sealWithPin(page);
        await addCapabilities(page, ["External connectors"]);
        await tabStep({ press: (el) => el.click(), visit }).tab(page, "Connections");
        for (const id of ["vault", "openbao", "make", "asana", "e2b"]) {
          await visit(page, `connections/${id}`);
          await page.locator(".conn-settings").waitFor({ state: "visible", timeout: 15000 });
          const form = page.locator(".cx-setup .cx-form").first();
          await form.waitFor({ state: "visible", timeout: 15000 });
          await form.scrollIntoViewIfNeeded();
          const fields = await form.locator("input, select, textarea").count();
          const actions = await form.getByRole("button", { name: /sign in|connect/i }).count();
          if (phase === "after" && session === "guest") {
            assert.equal(fields, 0, `${id}: guest fields`);
            assert.equal(actions, 0, `${id}: guest connect action`);
          }
          if (phase === "after" && session === "genuine") assert.ok(fields > 0, `${id}: genuine configuration fields`);
          await page.screenshot({ path: path.join(out, `${phase}-${session}-${label}-${id}.png`), fullPage: true });
          results.push({ phase, session, label, width, height, id, fields, actions });
          if (session === "genuine") {
            await lockVault(page);
            await visit(page, `connections/${id}`);
            await page.getByLabel(/^(PIN|Password)$/).waitFor({ state: "visible", timeout: 15000 });
            assert.equal(await page.locator(".cx-setup .cx-form input:visible, .cx-setup .cx-form select:visible, .cx-setup .cx-form textarea:visible").count(), 0, `${id}: locked credential fields`);
            assert.equal(await page.locator(".cx-setup .cx-form").getByRole("button", { name: /sign in|connect/i }).filter({ visible: true }).count(), 0, `${id}: locked actions`);
            await page.screenshot({ path: path.join(out, `${phase}-locked-${label}-${id}.png`), fullPage: true });
            results.push({ phase, session: "locked", label, width, height, id, credentialFields: 0, actions: 0 });
            await unlockWithPin(page);
          }
        }
      } finally { await context.close(); }
    }
  }
  const errors = harness.log.filter((entry) => entry.kind === "PAGE-ERROR" || entry.kind === "LOOPBACK-REQUEST");
  assert.equal(errors.length, 0, "page and loopback errors");
} finally {
  await browser.close();
  fs.writeFileSync(path.join(out, "measurements.json"), JSON.stringify({ approval: "unapproved review artifact", results, log: harness.log, failures: harness.failures }, null, 2));
}
