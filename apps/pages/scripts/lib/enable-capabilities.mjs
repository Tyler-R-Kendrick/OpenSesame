/**
 * Switching every optional capability on, the way a person does: Settings ›
 * Capabilities and each section's own switch. Some capabilities reload the
 * document, and a load locks the vault, so this unlocks and carries on until
 * no switch is left off.
 */

import { unlockIfLocked } from "./tutorial-walk.mjs";

/** Back on Settings › Capabilities, unlocked: a load locks the vault. */
async function atCapabilities(page, url) {
  if (await unlockIfLocked(page)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await unlockIfLocked(page);
  }
  if (!page.url().includes("/settings/capabilities")) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await unlockIfLocked(page);
  }
  await page
    .locator(".capsections")
    .waitFor({ state: "attached", timeout: 15000 })
    .catch(() => {});
}

const OFF_SWITCH =
  '.capsection__head .capsection__switch[aria-checked="false"]';

/** Presses the first switch that is off; false when none is (or the page is mid-reload). */
async function switchNextOn(page, round, verbose) {
  const off = page.locator(OFF_SWITCH);
  try {
    const label = await off
      .first()
      .getAttribute("aria-label", { timeout: 2500 });
    if (verbose) console.log(`  switching on ${label} (round ${round})`);
    await off.first().click({ timeout: 4000 });
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(500);
    return true;
  } catch {
    await page.waitForTimeout(700);
    return false;
  }
}

/** Switch every section on, riding out the reloads some of them need. */
export async function enableEverything(
  page,
  { origin, base, verbose = false },
) {
  const url = `${origin}${base}settings/capabilities`;
  for (let round = 0; round < 80; round += 1) {
    await atCapabilities(page, url);
    const pressed = await switchNextOn(page, round, verbose);
    if (pressed) continue;
    const locked = await page
      .getByLabel("Password", { exact: true })
      .isVisible()
      .catch(() => false);
    if ((await page.locator(OFF_SWITCH).count()) === 0 && !locked) return;
  }
}
