/**
 * J-DURESS-GUEST: a guest with no key yet still finds Duress and Travel on
 * Settings › Security (ADR 0158: the row that needs a setting opens the sheet
 * that sets it), in the built app with nothing mocked.
 *
 * Skip at the front door seals nothing, so there is no key for a code to
 * guard. Both sections are drawn anyway, marked "After a key", and Add opens
 * the key sheet. Once a PIN is set the real Duress and Travel rows appear and
 * the placeholders are gone; the Duress sheet then lists every mode.
 */
import { doorGuest } from "./front-door.mjs";
import { openSettingsCategory, waitOpen } from "./pages-journey.mjs";

const PIN = "48291037";

const text = async (page, selector) =>
  (await page.locator(selector).innerText()).replace(/\s+/g, " ");

export async function walkJDuressGuest({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);
  await openSettingsCategory(page, "Security");
  await page
    .getByRole("heading", { name: "Unlock methods" })
    .waitFor({ timeout: 15000 });

  await page.locator("#duress-after-key").waitFor({ timeout: 15000 });
  check(
    (await page.locator("#travel-after-key").count()) === 1,
    "a keyless guest is drawn the Travel section on Security",
  );
  check(
    /After a key/.test(await text(page, "#duress-after-key")) &&
      /After a key/.test(await text(page, "#travel-after-key")),
    "both rows say they come after a key",
  );
  check(
    (await page.locator("#duress-profiles, #travel").count()) === 0,
    "the real Duress and Travel panels are not drawn before a key exists",
  );
  await snap(page, "J-DURESS-GUEST-before-key");

  // Add opens the key sheet, the same road the page's first line points at.
  await page
    .locator("#duress-after-key")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  const dialog = page.locator("[role=dialog]");
  await dialog.waitFor({ timeout: 15000 });
  // The sheet opens on the passkey card; a PIN is the road a script can walk.
  await dialog.getByRole("button", { name: "Use a PIN instead" }).click();
  const fields = dialog.locator("input[type=password]");
  await fields.nth(0).fill(PIN);
  await fields.nth(1).fill(PIN);
  await snap(page, "J-DURESS-GUEST-key-sheet");
  await dialog.getByRole("button", { name: "Set PIN" }).first().click();

  await page.locator("#duress-profiles").waitFor({ timeout: 30000 });
  check(
    (await page.locator("#travel").count()) === 1,
    "once the guest has a key, the Travel panel is drawn",
  );
  check(
    (await page.locator("#duress-after-key, #travel-after-key").count()) === 0,
    "the placeholder sections are gone once the real ones are drawn",
  );
  await snap(page, "J-DURESS-GUEST-after-key");

  await page
    .locator("#duress-profiles")
    .getByRole("button", { name: "Add" })
    .last()
    .click();
  const modes = await page
    .getByRole("radio")
    .evaluateAll((nodes) => nodes.map((n) => n.closest("label")?.innerText));
  // "Show my vault without the items I hide" needs items to hide, and a
  // guest's new vault holds none, so the sheet lists the rest.
  check(
    ["Decoy vault", "Wrong password", "Freeze for a while"].every((mode) =>
      modes.includes(mode),
    ),
    `the Duress sheet lists the modes (${modes.join(" | ")})`,
  );
  await snap(page, "J-DURESS-GUEST-modes");
}
