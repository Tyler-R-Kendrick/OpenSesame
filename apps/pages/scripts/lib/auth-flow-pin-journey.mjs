import {
  enterEnrollmentCode,
  finishUnlockWithCode,
  readSeed,
  withdrawSelfAuthenticator,
} from "./auth-flow-enroll.mjs";
import { lock } from "./auth-flow-nav.mjs";
import { passTheDoor } from "./front-door.mjs";

/** Journey 2: a PIN-sealed vault enrolls MFA directly. */
export async function pinMfaJourney({
  browser,
  newPage,
  check,
  snap,
  goSecurity,
  setStep,
  PIN,
  ORIGIN,
  BASE,
  text,
  totp,
}) {
  const { page, context } = await newPage(browser);
  setStep("2-pin");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "PIN" }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
  await page.waitForTimeout(5000);
  check(/@/.test(await text(page)), "sealed device landed inside the app");
  await goSecurity(page);
  await page
    .locator(".sw--method", { hasText: "Authenticator app" })
    .getByRole("button", { name: "Add" })
    .click();
  await page.waitForTimeout(2500);
  const dialog = page.getByRole("dialog");
  await snap(page, "2-pin-scan");
  check(
    (await dialog.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "1 · Scan",
    "straight to Scan — no key step for a vault that has one",
  );
  const steps = await dialog.locator(".steps__label").allTextContents();
  check(
    steps.length === 2 &&
      /2 · Confirm/.test(steps.join(" ")) &&
      !steps.some((label) => /Key/.test(label)),
    "two steps, no key step",
  );
  const secret = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, totp(secret));
  await page.waitForTimeout(1500);
  check(/Authenticator on/.test(await text(page)), "authenticator on");
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  await withdrawSelfAuthenticator(page, check);
  await lock(page);
  const locked = await snap(page, "2-pin-locked");
  check(
    (await page.getByRole("tab", { name: "PIN" }).count()) === 1 &&
      (await page.getByRole("tab", { name: "Password" }).count()) === 0,
    "only the PIN tab is offered",
  );
  check(/2 · Authenticator code/.test(locked), "step 2 announced");
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForTimeout(5000);
  await finishUnlockWithCode(page, secret, "2-pin", {
    check,
    snap,
    totp,
  });
  await context.close();
}
