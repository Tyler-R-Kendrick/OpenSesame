import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [phase, root, out] = process.argv.slice(2);
if (!["before", "after"].includes(phase)) throw new Error("Unknown phase");
fs.mkdirSync(out, { recursive: true });
const imp = (p) => import(pathToFileURL(path.join(root, p)));
const { createHarness } = await imp("apps/pages/scripts/lib/static-origin-harness.mjs");
const { sealWithPin, addCapabilities } = await imp("apps/pages/scripts/lib/pages-journey.mjs");
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
        for (const [id, name] of [["vercel-sandbox", "Vercel Sandbox"], ["e2b", "E2B"], ["browserbase-cdp", "Browserbase CDP"]]) {
          await visit(page, `connections/${id}`);
          await page.locator(".conn-settings").waitFor({ state: "visible", timeout: 15000 });
          const form = page.locator(".cx-setup .cx-form").first();
          await form.waitFor({ state: "visible", timeout: 15000 });
          await form.scrollIntoViewIfNeeded();
          const button = form.getByRole("button", { name: `Verify and connect ${name}` });
          const expected = phase === "after" && session === "genuine";
          if (expected) {
            await button.waitFor({ state: "visible", timeout: 15000 });
            assert.equal(await button.isEnabled(), true, `${id}: local save available`);
          } else assert.equal(await button.count(), 0, `${id}: no save action`);
          await page.screenshot({ path: path.join(out, `${phase}-${session}-${label}-${id}.png`), fullPage: true });
          if (expected) {
            await button.click();
            try {
              await page.getByText(`${name} configuration validated locally and saved on this device. Provider access was not checked.`, { exact: true }).waitFor({ state: "visible", timeout: 15000 });
            } catch (error) {
              await page.screenshot({ path: path.join(out, `${phase}-${session}-${label}-${id}-failure.png`), fullPage: true });
              console.log("synthetic fixture settings text:", (await page.locator(".conn-settings").innerText()).slice(0, 4000));
              console.log("synthetic fixture alerts:", (await page.locator('[role="alert"]').allInnerTexts()).join(" | ").slice(0, 2000));
              throw error;
            }
            await page.screenshot({ path: path.join(out, `${phase}-${session}-${label}-${id}-saved.png`), fullPage: true });
          }
          results.push({ phase, session, label, width, height, id, saveAvailable: expected, saved: expected });
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
