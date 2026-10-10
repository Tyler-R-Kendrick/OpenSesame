/**
 * Switching every optional capability on, the way a person does: Settings ›
 * Capabilities and each section's own switch. Some capabilities reload the
 * document, and a load locks the vault, so this unlocks and carries on until
 * no switch is left off.
 */

import { awaitCapabilitySections, capabilityOnSwitch } from "./always-on.mjs";
import { unlockIfLocked } from "./tutorial-walk.mjs";

/** Support models (ADR 0088). Tutorial profile walks leave both unapproved. */
export const SUPPORT_MODEL_TITLES = Object.freeze([
  "On-device model",
  "Remote support model",
]);

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

/** True once no approved switch still carries this catalog title. */
async function modelIsOff(page, title) {
  try {
    await page.waitForFunction(
      (name) =>
        ![
          ...document.querySelectorAll("[role=switch][data-capability-title]"),
        ].some(
          (node) =>
            node.getAttribute("data-capability-title") === name &&
            node.getAttribute("aria-checked") === "true",
        ),
      title,
      { timeout: 15000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the on-device and remote support models off, then fail if either
 * switch is still approved. A title with no switch is already off.
 *
 * Each switch commits in place from the snapshot it was pressed on. The next
 * press has to wait until that commit has landed: a second press read too
 * soon proposes the old roots, and whichever commit finishes last puts the
 * first model back on. A navigation in that window drops the commit.
 */
export async function ensureModelsOff(page, { origin, base, verbose = false }) {
  const url = `${origin}${base}settings/capabilities`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await unlockIfLocked(page);
  await awaitCapabilitySections(page).catch(() => {});
  for (const title of SUPPORT_MODEL_TITLES) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const on = capabilityOnSwitch(page, title);
      if ((await on.count()) === 0) break;
      if (verbose) console.log(`  switching off ${title}`);
      await on.first().click({ timeout: 4000 });
      const apply = page.getByTestId("capability-apply");
      if (await apply.isVisible().catch(() => false)) {
        await apply.click({ timeout: 4000 });
      }
      if (await modelIsOff(page, title)) break;
      await unlockIfLocked(page);
    }
  }
  const still = [];
  for (const title of SUPPORT_MODEL_TITLES) {
    if ((await capabilityOnSwitch(page, title).count()) > 0) still.push(title);
  }
  if (still.length > 0) {
    throw new Error(`support AI still approved: ${still.join(", ")}`);
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
