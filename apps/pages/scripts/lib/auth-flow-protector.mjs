/**
 * Journey 3 of `verify-auth-flow.mjs`: a vault opened from an enrolled
 * protector (ADR 0152). A PIN-sealed vault enrolls a recovery key through
 * Settings, then an authenticator; it is locked, and the unlock screen must
 * draw exactly the enrolled methods, refuse a wrong key without opening
 * anything, open with the right one — and still ask for the authenticator code
 * — and then honour the person's preference, in the same session and after a
 * reload. Everything is driven from the keyboard-reachable controls a person
 * would use; the key itself is read from the file the page hands over once.
 */
import fs from "node:fs";
import {
  enterEnrollmentCode,
  finishUnlockWithCode,
  readSeed,
  withdrawSelfAuthenticator,
} from "./auth-flow-enroll.mjs";
import { passTheDoor } from "./front-door.mjs";
import { readTray } from "./tray-contract.mjs";

const tabs = (page) =>
  page
    .getByRole("tab")
    .evaluateAll((els) => els.map((el) => el.textContent.trim()));

async function sealWithPin(page, pin) {
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "PIN" }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(pin);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(pin);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
  await page.waitForTimeout(5000);
}

/** Add a recovery key from Settings and return the secret the page handed over. */
async function enrollRecoveryKey(page) {
  await page.getByRole("button", { name: "Add key protection method" }).click();
  await page.waitForTimeout(500);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Recovery key", exact: true })
      .click(),
  ]);
  const secret = fs.readFileSync(await download.path(), "utf8").trim();
  await page.waitForTimeout(1500);
  return secret;
}

async function enrollAuthenticator(page, { check, totp }) {
  await page
    .locator(".sw--method", { hasText: "Authenticator app" })
    .getByRole("button", { name: "Add" })
    .click();
  await page.waitForTimeout(2500);
  const dialog = page.getByRole("dialog");
  const seed = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, totp(seed));
  await page.waitForTimeout(1500);
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  return seed;
}

const focusedId = (page) => page.evaluate(() => document.activeElement?.id);

/** Enroll a recovery key, then an authenticator, from Settings; return both. */
async function enrollBoth(page, h) {
  const { check, snap, openSecurity, totp } = h;
  await openSecurity(page);
  check(
    (await page.locator(".sw--method", { hasText: "Recovery key" }).count()) ===
      0,
    "no recovery key is enrolled to begin with",
  );
  const key = await enrollRecoveryKey(page);
  check(key.length >= 40, "the recovery key was handed over as a file, once");
  const row = page.locator(".sw--method", { hasText: "Recovery key" });
  await snap(page, "3-protector-enrolled");
  check(
    (await row.getByRole("img", { name: "Verified" }).count()) === 1,
    "the recovery key is listed as verified",
  );
  const preferred = row.getByRole("button", {
    name: "Preferred unlock Recovery key",
  });
  const remove = row.getByRole("button", { name: "Remove Recovery key" });
  check(
    (await preferred.count()) === 1 && (await remove.count()) === 1,
    "a verified recovery key can be preferred and removed from its row",
  );
  const seed = await enrollAuthenticator(page, { check, totp });
  await withdrawSelfAuthenticator(page, check);
  return { key, seed };
}

/** The locked screen: exact tabs, a wrong key refused, the right one opens. */
async function unlockFromRecoveryKey(page, h, { key, seed }) {
  const { check, snap, totp } = h;
  const locked = await snap(page, "3-protector-locked");
  const names = await tabs(page);
  check(
    names.join(",") === "PIN,Recovery key",
    `the tabs are exactly the enrolled methods (${names.join(", ")})`,
  );
  check(
    /1 · Key/.test(locked) && /2 · Authenticator code/.test(locked),
    "the code is announced as step 2 before any key is taken",
  );
  const guest = page.getByRole("button", { name: "Skip to the guest vault" });
  check((await guest.count()) === 1, "guest stays offered beside the new tab");

  await page.getByRole("tab", { name: "Recovery key" }).click();
  await page.waitForTimeout(300);
  check(
    (await focusedId(page)) === "unlock-protector",
    "focus lands in the recovery key field on arrival to the tab",
  );
  // Wrong key: refused in plain words, nothing opens, the field is cleared and
  // the caret is back in it. The vault key is never named.
  await page.keyboard.type("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const body = await snap(page, "3-protector-wrong-key");
  // The caret is read before the tray is: opening the bell moves focus to it.
  const caret = await focusedId(page);
  const refused = `${body} ${await readTray(page)}`;
  await page.getByLabel("Recovery key", { exact: true }).focus();
  check(
    /That recovery key did not unlock the vault/.test(refused),
    "a wrong recovery key is refused in plain words",
  );
  check(
    !/Confirm it is you/.test(refused),
    "a wrong recovery key reaches no second step",
  );
  const field = page.getByLabel("Recovery key", { exact: true });
  check(
    (await field.inputValue()) === "",
    "the wrong key is not left in the field",
  );
  check(
    caret === "unlock-protector",
    "the caret is back in the field after a refusal",
  );

  // The right key, from the keyboard: Enter submits. The code is still asked.
  await page.keyboard.type(key);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await finishUnlockWithCode(page, seed, "3-protector", { check, snap, totp });
}

/** Preferred: the unlock screen opens on it, now and after a reload. */
async function preferRecoveryKey(page, h) {
  const { check, snap, setStep, openSecurity, lock, ORIGIN, BASE } = h;
  await openSecurity(page);
  const prefer = page.getByRole("button", {
    name: "Preferred unlock Recovery key",
  });
  await prefer.click();
  await page.waitForTimeout(800);
  await lock(page);
  await page.waitForTimeout(500);
  const recoveryTab = page.getByRole("tab", { name: "Recovery key" });
  check(
    (await recoveryTab.getAttribute("aria-selected")) === "true",
    "the preferred recovery key is the tab the screen opens on",
  );
  setStep("3-protector-reload");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const reloaded = await snap(page, "3-protector-reloaded");
  check(/^Unlock$/m.test(reloaded), "a reload lands on Unlock");
  const selected = await recoveryTab.getAttribute("aria-selected");
  check(
    (await tabs(page)).join(",") === "PIN,Recovery key" && selected === "true",
    "after a reload the tabs and the preference are still the enrolled ones",
  );
  check(
    (await focusedId(page)) === "unlock-protector",
    "focus lands in the recovery key field after a reload, with no click",
  );
}

export async function protectorJourney(h) {
  const { browser, newPage, setStep, lock, PIN, ORIGIN, BASE } = h;
  const { page, context } = await newPage(browser);
  setStep("3-protector");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await sealWithPin(page, PIN);
  const secrets = await enrollBoth(page, h);
  await lock(page);
  await unlockFromRecoveryKey(page, h, secrets);
  await preferRecoveryKey(page, h);
  await context.close();
}
