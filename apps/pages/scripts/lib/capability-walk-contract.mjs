// What an installation carries, and how a person changes it (ADR 0130), on
// the production origin. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.
//
// The claim under test is an absence followed by a presence: a device that
// has approved nothing has no rail row, no route and no section for an
// optional capability, and the moment a person adds one through Settings ›
// Capabilities it is there. An absence alone proves nothing — a section can
// vanish because it crashed — so each capability is checked both ways.
// Always-on capabilities (ADR 0135, 0138) are the opposite claim: present
// with nothing chosen, and never offered a switch.

import {
  ALWAYS_ON_TITLES,
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilitySwitch,
} from "./always-on.mjs";

/** Rail rows an installation that has approved nothing must not have. */
const GATED_RAIL_ROWS = ["wallet/"];

/**
 * Rail rows of always-on capabilities (ADR 0135): there before any choice.
 * Identity is browser-local IAM's, always on since ADR 0138.
 */
const ALWAYS_ON_RAIL_ROWS = [
  "identity/",
  "connections/",
  "access/",
  "activity/",
];

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
  for (const row of ALWAYS_ON_RAIL_ROWS) {
    check(
      rows.some((text) => text.startsWith(row)),
      `${row} is there with nothing chosen: it is always on`,
    );
  }
  check(
    rows.some((text) => text.startsWith("vault/")) &&
      rows.some((text) => text.startsWith("settings/")),
    "the core sections are there regardless",
  );
  // Guided help is always on, so the statusline's Support key is there
  // before anything is chosen.
  check(
    (await page.locator('button[aria-label="Support"]').count()) > 0,
    "the Support key is there: guided help is always on",
  );
}

/** Open Settings › Capabilities from wherever the walk is. */
async function openCapabilities(page) {
  await page.locator(".railtree__row", { hasText: "settings" }).first().click();
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
export async function addCapability(page, check, snap, title, rail = null) {
  await openCapabilities(page);
  await awaitCapabilitySections(page);
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
  const review = await page
    .locator('[data-testid="capability-review"]')
    .innerText();
  await snap(page, `add-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  check(
    review.includes(title),
    `the review for ${title} names the capability it would start`,
  );
  const enableRow = review.split("enable")[1] ?? "";
  check(
    enableRow.trimStart().startsWith(title),
    `the review's enable row states ${title}, not "—"`,
  );
  const apply = page.getByRole("button", { name: /Apply configuration/ });
  check(!(await apply.isDisabled()), `Apply is offered for ${title}`);
  await apply.click();
  await page.waitForTimeout(2200);
  // Not every capability owns a section — some add a tab or a control to one
  // the plan already has — so a caller names a rail row only where there is
  // one to name, and the presence check is skipped rather than faked.
  if (rail === null) return;
  const rows = (await page.locator(".railtree__row").allTextContents()).map(
    (text) => text.trim(),
  );
  check(
    rows.some((text) => text.startsWith(rail)),
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
  await page
    .getByRole("button", { name: /Customize this installation/ })
    .click();
  await page.waitForTimeout(700);
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
