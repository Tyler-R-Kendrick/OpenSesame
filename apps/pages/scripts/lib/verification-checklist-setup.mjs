/**
 * Front door, setup choices, and the no-account road into the vault.
 *
 * Minimal, Default and Full commit and return. Custom opens the capabilities
 * ceremony; Skip all still retires the door onto sign-in.
 */

import { sealLocalOnly } from "./pages-journey.mjs";
import {
  BASE,
  ORIGIN,
  mark,
  visibleClick,
  waitPastSetup,
} from "./verification-checklist-shot.mjs";

const CHOICES = ["Minimal", "Default", "Full", "Custom"];

export async function openDoor(page, shot, record) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Set up your own", exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
  await shot("front-door");
  const skip = await page
    .getByRole("button", { name: "Skip sign-in and continue as guest" })
    .count();
  const guestButton = await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .count();
  mark(record, "U3-door-skip", skip === 1, `skip buttons: ${skip}`);
  mark(
    record,
    "U3-no-continue-as-guest-on-door",
    guestButton === 0,
    `Continue as guest: ${guestButton}`,
  );
}

export async function captureChoices(page, shot, record) {
  await visibleClick(page, "button", "Set up your own");
  await page
    .getByRole("button", { name: "Minimal", exact: true })
    .waitFor({ timeout: 15_000 });
  const text = await shot("setup-choices");
  let present = 0;
  for (const name of CHOICES) {
    present += await page.getByRole("button", { name, exact: true }).count();
  }
  mark(
    record,
    "U15-choices",
    present === 4 && /Full/.test(text),
    `${present} choices`,
  );
  const reset = await page.getByRole("button", { name: /reset/i }).count();
  await shot("setup-no-reset");
  mark(record, "U2-no-setup-reset", reset === 0, `reset buttons: ${reset}`);
  await page.getByRole("button", { name: "Minimal", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  await shot("setup-keyboard");
  mark(record, "U1-setup-keyboard", focused === "Default", focused);
}

async function finishCustom(page, shot, record) {
  await page
    .getByRole("tab", { name: "capabilities" })
    .waitFor({ timeout: 20_000 });
  const ceremony = await shot("setup-capabilities");
  mark(
    record,
    "custom-ceremony",
    /Use the minimal configuration/.test(ceremony),
    "capabilities tab",
  );
  const customize = page.getByRole("button", {
    name: /^Customize this installation/,
  });
  const customized = await customize
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (customized) {
    await customize.click();
    const personal = page.getByRole("button", { name: /^Personal/ });
    const personalSeen = await personal
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (personalSeen) await personal.click();
    await shot("setup-custom");
  }
  const left = await visibleClick(page, "button", "Skip all", 8_000);
  if (!left) await visibleClick(page, "button", "Close", 8_000);
}

export async function applySetupChoice(page, shot, record, choice) {
  await visibleClick(page, "button", choice);
  if (choice === "Custom") await finishCustom(page, shot, record);
  const where = await waitPastSetup(page);
  record.landed = where;
  if (where === "sign-in") {
    const text = await shot("sign-in");
    const guest = await page
      .getByRole("button", { name: "Continue as guest", exact: true })
      .count();
    mark(
      record,
      "U3-sign-in",
      guest === 0 && /Use without an account/.test(text),
      "no Continue as guest; local seal remains",
    );
  }
  return where;
}

/** Local seal after setup, or the door's Skip when setup returned there. */
export async function enterVault(page, where) {
  if (where === "app") return "local";
  if (where === "door") {
    await visibleClick(page, "button", "Skip sign-in and continue as guest");
    await page
      .getByRole("button", { name: "Lock vault" })
      .locator("visible=true")
      .first()
      .waitFor({ timeout: 25_000 });
    return "guest";
  }
  await sealLocalOnly(page);
  return "local";
}
