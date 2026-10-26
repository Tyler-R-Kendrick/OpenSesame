import { waitOpen } from "./pages-journey.mjs";
import { toTheList } from "./phone-vault.mjs";
import { openSessionSection } from "./session-section.mjs";
import { readTray } from "./tray-contract.mjs";
/**
 * The unlock/MFA ceremony's page-driving for `verify-auth-flow.mjs`: read the
 * setup key out of the sheet, type a code into its Confirm step, put the vault's
 * own authenticator back afterwards, and finish an unlock through its code
 * step. Split from the walk so each half can be read on its own (and so the
 * walk file stays inside its budget). The two finishers take the walk's `check`
 * and `snap`, because where a check stands is the walk's own state.
 */

/** The base32 setup key behind the "can't scan" road, with its QR beside it. */
export async function readSeed(page, check) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Can't scan? Type the key instead" })
    .click();
  await page.waitForTimeout(300);
  const spaced = await dialog
    .getByLabel("Setup key", { exact: true })
    .inputValue();
  const secret = spaced.replace(/\s/g, "");
  check(/^[A-Z2-7]{16,}$/.test(secret), "the setup key is a base32 seed");
  check(
    (await dialog
      .getByRole("img", { name: "Scan to add vault MFA" })
      .count()) === 1,
    "the QR code is on screen beside it",
  );
  return secret;
}

/** Enter a code in the sheet's Confirm step and press Turn on. */
export async function enterEnrollmentCode(page, code) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Six digits", { exact: true }).fill(code);
  await dialog.getByRole("button", { name: "Turn on" }).click();
}

/**
 * A wrong enrollment code is refused on the field that was refused — a mark
 * whose sentence is its name — not in a box on the page behind the sheet
 * (DESIGN.md).
 */
export async function expectRefusedOnField(page, check) {
  const dialog = page.getByRole("dialog");
  check(
    (await dialog.getByRole("img", { name: "Did not match" }).count()) === 1 &&
      (await page.locator(".note").count()) === 0,
    "a wrong enrollment code is refused, on the field",
  );
}

/** Trash the vault's self-supplied authenticator: an item in the vault. */
export async function withdrawSelfAuthenticator(page, check) {
  // Desktop Settings has its own Back to vault row; the phone uses its
  // section drawer. Once back, Vault is not an item in the Session menu.
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
  else await openSessionSection(page, "Vault");
  await toTheList(page);
  await page.waitForTimeout(1000);
  // The account is an entry, and so is the authenticator bound to it
  // ("... · Authenticator", ADR 0179); the account is the one to trash.
  const entry = page.getByRole("treeitem", {
    name: /OpenSesame \(this vault\)(?! ·)/,
  });
  check((await entry.count()) === 1, "the vault registered its own entry");
  await entry.first().click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Move to trash" }).click();
  // The first press arms the key. The second is the move.
  await page.getByRole("button", { name: "Really move to trash?" }).click();
  await page.waitForTimeout(1000);
}

function hasPositiveHeight(box) {
  return box !== null && box.height > 0;
}

function containsVertically(region, box) {
  return box.y >= region.y && box.y + box.height <= region.y + region.height;
}

/** The gate owns the notice seat; its actual heading and form own the controls. */
async function refusalClearsUnlockControls(page) {
  const card = page.locator(".unlock.unlock--lock-v5 > .unlock__card");
  const notice = card.locator(".gate-notice-seat > .notice-corner");
  const corner = await notice.boundingBox();
  const bell = await notice
    .getByRole("button", { name: /^Notifications — / })
    .boundingBox();
  const refusal = await notice
    .getByText("That authenticator code is not valid.", { exact: true })
    .boundingBox();
  const heading = await card.locator(":scope > .unlock__heading").boundingBox();
  const form = await card.locator(":scope > form.unlock__form").boundingBox();
  if (![corner, bell, refusal, heading, form].every(hasPositiveHeight))
    return false;
  if (![bell, refusal].every((box) => box.width > 0)) return false;
  return (
    corner.y + corner.height <= Math.min(heading.y, form.y) &&
    [bell, refusal].every((box) => containsVertically(corner, box))
  );
}

/** The code step after a key: wrong code refused, right code opens the vault. */
export async function finishUnlockWithCode(
  page,
  secret,
  name,
  { check, snap, totp },
) {
  const asked = await snap(page, `${name}-code-asked`);
  check(/Confirm it is you/.test(asked), "the code is asked for after the key");
  check(/Authenticator code/.test(asked), "code field on screen");
  check(
    (await page.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "2 · Authenticator code",
    "the rail marks step 2 as the current step",
  );
  // A full code submits itself; the wrong one is refused without a click.
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  await page.waitForTimeout(800);
  check(
    await refusalClearsUnlockControls(page),
    "the refusal and its bell sit above the unlock form without covering controls",
  );
  const refused = `${await snap(page, `${name}-wrong-code`)} ${await readTray(page)}`;
  check(/not valid/i.test(refused), "a wrong code is refused in plain words");
  check(
    /Confirm it is you/.test(refused),
    "still on step 2 after a wrong code",
  );
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(totp(secret));
  await waitOpen(page);
  const open = await snap(page, `${name}-open`);
  check(
    /vault\/|:\/\s*$/m.test(open) && !/Confirm it is you/.test(open),
    "the vault is open",
  );
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) > 0,
    "the shell (with its lock) is on screen",
  );
}

/** A self-supplied code opens without asking — the point of the whole thing. */
export async function finishUnlockSelfSupplied(page, name, { check, snap }) {
  await waitOpen(page);
  const open = await snap(page, `${name}-self-supplied`);
  check(!/Confirm it is you/.test(open), "no code is asked — it is supplied");
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) > 0,
    "the vault is open",
  );
}
