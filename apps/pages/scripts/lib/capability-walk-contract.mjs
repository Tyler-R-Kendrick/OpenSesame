// What an installation carries, and how a person changes it (ADR 0130), on
// the production origin. Split from verify-static-origin.mjs like the other
// contracts so the walk stays one screen per file.
//
// The claim under test is an absence followed by a presence: a device that
// has approved nothing has no rail row, no route and no section for an
// optional capability, and the moment a person adds one through Settings ›
// Capabilities it is there. An absence alone proves nothing — a section can
// vanish because it crashed — so each capability is checked both ways.

/** Rail rows an installation that has approved nothing must not have. */
const GATED_RAIL_ROWS = ["connections/", "access/", "identity/", "wallet/"];

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
  check(
    rows.some((text) => text.startsWith("vault/")) &&
      rows.some((text) => text.startsWith("settings/")),
    "the core sections are there regardless",
  );
  // A capability that adds a control rather than a section is gated the same
  // way: the statusline's Support key belongs to guided help, and an
  // installation without it has no key at all, not a disabled one.
  check(
    (await page.locator('button[aria-label="Support"]').count()) === 0,
    "the Support key is absent until guided help is approved",
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
  const add = page.getByRole("button", { name: `Add ${title}`, exact: true });
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
