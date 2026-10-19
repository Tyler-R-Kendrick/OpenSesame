/** Real-browser regression for diagnostic rows unmounted on connection. */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { observePeeringDiagnostic } from "./lib/peering-diagnostic-observation.mjs";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});
try {
  const page = await browser.newPage();
  const selector = '[data-testid="live-join-ice"]';
  for (const text of ["Checking route 1s", "", "invalid diagnostic"]) {
    await page.setContent('<div data-testid="live-join-ice"></div>');
    await page.locator(selector).evaluate((node, value) => {
      node.textContent = value;
      node.style.cssText = "width:100px;height:20px";
    }, text);
    const captured = await observePeeringDiagnostic(page, selector);
    await page.locator(selector).evaluate((node) => node.remove());
    // The old post-connect locator read fails after this genuine unmount.
    await assert.rejects(
      page.locator(selector).textContent({ timeout: 150 }),
      /Timeout/,
    );
    assert.equal(captured, text);
    assert.equal(
      Boolean(
        captured && /Checking|Gathering|Connected|route|\d+s/i.test(captured),
      ),
      text === "Checking route 1s",
    );
  }
  await page.setContent(
    '<div data-testid="live-join-ice" style="visibility:hidden">invalid hidden text</div>',
  );
  const observation = observePeeringDiagnostic(page, selector);
  // Let the real observer inspect the hidden row before making it visible.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.locator(selector).evaluate((node) => {
    node.textContent = "Gathering route 2s";
    node.style.visibility = "visible";
  });
  assert.equal(await observation, "Gathering route 2s");
  console.log(
    "PASS visible diagnostic survives unmount; hidden/empty/invalid stay refused",
  );
} finally {
  await browser.close();
}
