// What an installation carries, and how a person changes it (ADR 0130), on
// the production origin. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.
//
// The claim under test is an absence followed by a presence: optional
// capabilities the PWA does not default on have no rail row until a person
// adds them through Settings › Capabilities; Access and browser-local IAM
// are on by product default (Tyler D2) and must already be present. An
// absence alone proves nothing — a section can vanish because it crashed —
// so each non-default optional is checked both ways. Always-on capabilities
// (ADR 0135, 0142) are present with nothing chosen and never offered a switch.

import {
  ALWAYS_ON_TITLES,
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
  capabilitySwitch,
} from "./always-on.mjs";
import { openSessionMenu, openSessionSection } from "./session-section.mjs";

/**
 * Rail rows an installation that has approved nothing must not have.
 * Connections, Access and Identity are optional extensions (ADR 0153).
 */
const GATED_RAIL_ROWS = ["wallet/", "connections/"];

/**
 * Activity is always on, and it is a session root rather than a rail
 * directory. The session menu is what proves it is still there.
 */

/** A. Nothing optional is on the rail before anything is chosen. */
export async function checkGatedSectionsAbsent(page, check) {
  const rows = (await page.locator(".railtree__row").allTextContents()).map(
    (text) => text.trim(),
  );
  for (const row of GATED_RAIL_ROWS) {
    check(
      !rows.some((text) => text.startsWith(row)),
      `${row} is absent until its capability is approved`,
    );
  }
  for (const row of ["access/", "identity/"]) {
    check(
      rows.some((text) => text.startsWith(row)),
      `${row} is present: Access and IAM are PWA defaults`,
    );
  }
  check(
    rows.some((text) => text.startsWith("vault/")),
    "the vault is the rail root regardless",
  );
  check(
    !rows.some(
      (text) => text.startsWith("settings/") || text.startsWith("activity/"),
    ),
    "settings and activity are session roots, not rail directories",
  );
  await openSessionMenu(page);
  const menu = page.getByRole("menu");
  check(
    (await menu
      .getByRole("menuitem", { name: "Settings", exact: true })
      .count()) === 1,
    "the session menu offers Settings",
  );
  check(
    (await menu
      .getByRole("menuitem", { name: "Activity", exact: true })
      .count()) === 1,
    "the session menu offers Activity: it is always on",
  );
  await page.keyboard.press("Escape");
  // The minimal vault creates the base secret only (ADR 0153).
  check(
    (await page.locator('.railtree__kids a[href$="/vault?f=secret"]').count()) >
      0,
    "secret: the base kind is there with nothing chosen",
  );
  for (const kind of [
    "account",
    "note",
    "card",
    "passkey",
    "certificate",
    "drop",
  ]) {
    check(
      (await page
        .locator(`.railtree__kids a[href$="/vault?f=${kind}"]`)
        .count()) === 0,
      `${kind}: absent until its item type is chosen`,
    );
  }
  // Guided help is always on, so the statusline's Support key is there
  // before anything is chosen.
  check(
    (await page.locator('button[aria-label="Support"]').count()) > 0,
    "the Support key is there: guided help is always on",
  );
}

/** Open Settings › Capabilities from wherever the walk is. */
async function openCapabilities(page) {
  await openSessionSection(page, "Settings");
  await page.waitForTimeout(900);
  await page.getByRole("link", { name: "Capabilities", exact: true }).click();
  await page.waitForTimeout(900);
}

/**
 * B. Add one capability the way a person does, and hold the consent screen
 * to its job: it has to name what starts, not just what is owed. Resolving
 * the draft under the receipt still in hand approved nothing new, so this
 * row read "—" while Apply was about to start a capability and open an
 * egress class.
 */
async function expectRailRow(page, check, rail, detail) {
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if ((await back.count()) > 0) {
    await back.click();
    await page.waitForTimeout(700);
  } else {
    await page.locator(".railtree__row", { hasText: "vault/" }).first().click();
    await page.waitForTimeout(700);
  }
  const rows = (await page.locator(".railtree__row").allTextContents()).map(
    (text) => text.trim(),
  );
  check(rows.some((text) => text.startsWith(rail)), detail);
}

export async function addCapability(page, check, snap, title, rail = null) {
  await openCapabilities(page);
  await awaitCapabilitySections(page);
  const on = capabilityOnSwitch(page, title);
  if ((await on.count()) === 1) {
    check(true, `${title} is already on`);
    if (rail === null) return;
    await expectRailRow(
      page,
      check,
      rail,
      `${rail} is there: ${title} was already on`,
    );
    return;
  }
  const add = capabilityOffSwitch(page, title);
  if (ALWAYS_ON_TITLES.has(title)) {
    // Always on: there is nothing to add, and no switch offers to.
    check(
      (await capabilitySwitch(page, title).count()) === 0,
      `${title} is always on, not a switch`,
    );
    if (rail === null) return;
    const present = (
      await page.locator(".railtree__row").allTextContents()
    ).some((text) => text.trim().startsWith(rail));
    check(present, `${rail} is there: ${title} is always on`);
    return;
  }
  check((await add.count()) === 1, `Settings offers a way to add ${title}`);
  await add.click();
  await page.waitForTimeout(700);
  await snap(page, `add-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  check(
    (await page.locator('[data-testid="capability-review"]').count()) === 0,
    `${title} commits in place and stays on the capabilities page`,
  );
  check(
    (await capabilityOnSwitch(page, title).count()) === 1,
    `${title} is running after its switch`,
  );
  // Not every capability owns a section — some add a tab or a control to one
  // the plan already has — so a caller names a rail row only where there is
  // one to name, and the presence check is skipped rather than faked.
  if (rail === null) return;
  await expectRailRow(
    page,
    check,
    rail,
    `${rail} appears once ${title} is approved`,
  );
}

/**
 * C. Choose capabilities in the setup ceremony, before any vault exists.
 *
 * The other road into composition is Settings, which needs an open vault.
 * A gate that has to measure a surface *before* unlocking — the WebMCP boot
 * tools are registered on an empty vault — has to choose here instead.
 *
 * Returns the number of cards left selected, so a caller can assert that
 * what it asked for is what the ceremony carried into the review.
 */
export async function chooseInSetup(page, titles) {
  await page.getByRole("button", { name: "Set up your own" }).click();
  await page.waitForTimeout(900);
  // ADR 0154: the configuration choice sits in front of the ceremony.
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.waitForTimeout(700);
  await page
    .getByRole("button", { name: /Customize this installation/ })
    .click();
  await page.waitForTimeout(700);
  // The Custom purpose is what puts every capability card on screen.
  await page.getByRole("button", { name: /^Custom/ }).click();
  await page.waitForTimeout(900);
  for (const title of titles) {
    // An always-on capability has no card: it is in every plan already.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    const pick = page.locator(".capcard__pick", { hasText: title }).first();
    if ((await pick.count()) === 0) {
      throw new Error(`chooseInSetup: no capability card titled ${title}`);
    }
    if ((await pick.getAttribute("aria-pressed")) !== "true")
      await pick.click();
    await page.waitForTimeout(120);
  }
  const selected = await page
    .locator('.capcard__pick[aria-pressed="true"]')
    .count();
  await page.getByRole("button", { name: /Save on this device/ }).click();
  await page.waitForTimeout(1400);
  // A slot whose alternatives both got selected blocks Apply until one is
  // picked; the review offers them, so take the first of each.
  const alternatives = page.locator(".caprev__conflict .preset__opt");
  while ((await alternatives.count()) > 0) {
    await alternatives.first().click();
    await page.waitForTimeout(700);
  }
  const apply = page.getByRole("button", { name: /Apply configuration/ });
  if (await apply.isDisabled()) {
    throw new Error("chooseInSetup: Apply stayed blocked after the review");
  }
  await apply.click();
  await page.waitForTimeout(2400);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForTimeout(2600);
  return selected;
}
