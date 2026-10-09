import { doorGuest } from "./front-door.mjs";
import { guestEnrollMfa } from "./auth-flow-guest-enroll.mjs";
import {
  guestUnlockAfterMfa,
  guestUnlockAfterReload,
} from "./auth-flow-guest-unlock.mjs";

/** Journey 1: a guest asks for MFA and is walked through the key first. */
export async function guestMfaJourney({
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
}) {
  const { page, context } = await newPage(browser);
  setStep("1-guest");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await page.waitForTimeout(2000);
  check(/guest-\d+/.test(await text(page)), "guest landed inside the app");
  await goSecurity(page);
  await guestEnrollMfa(page, { check, snap, PIN });
  await guestUnlockAfterMfa(page, { check, snap, PIN });
  setStep("1-guest-reload");
  await guestUnlockAfterReload(page, {
    check,
    snap,
    PIN,
    ORIGIN,
    BASE,
  });
  await context.close();
}
