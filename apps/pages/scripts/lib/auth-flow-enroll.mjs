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

/** Trash the vault's self-supplied authenticator: an item in the vault. */
export async function withdrawSelfAuthenticator(page, check) {
  await page.getByRole("treeitem", { name: "Vault", exact: true }).click();
  await page.waitForTimeout(1000);
  const entry = page.getByRole("treeitem", {
    name: /OpenSesame \(this vault\)/,
  });
  check((await entry.count()) === 1, "the vault registered its own entry");
  await entry.first().click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.waitForTimeout(1000);
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
  const refused = await snap(page, `${name}-wrong-code`);
  check(/not valid/i.test(refused), "a wrong code is refused in plain words");
  check(
    /Confirm it is you/.test(refused),
    "still on step 2 after a wrong code",
  );
  await page
    .getByLabel("Authenticator code", { exact: true })
    .fill(totp(secret));
  await page.waitForTimeout(1500);
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
  const open = await snap(page, `${name}-self-supplied`);
  check(!/Confirm it is you/.test(open), "no code is asked — it is supplied");
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) > 0,
    "the vault is open",
  );
}
