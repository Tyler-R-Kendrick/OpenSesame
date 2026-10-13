import { finishUnlockSelfSupplied } from "./auth-flow-enroll.mjs";
import { lock } from "./auth-flow-nav.mjs";

export async function guestUnlockAfterMfa(page, { check, snap, PIN }) {
  await lock(page);
  const locked = await snap(page, "1-guest-locked");
  check(/^Unlock$/m.test(locked), "lock lands on Unlock");
  check(
    (await page.getByRole("tab", { name: "PIN" }).count()) === 1,
    "the PIN tab is offered",
  );
  check(
    (await page.getByRole("tab", { name: "Password" }).count()) === 0 &&
      (await page.getByRole("tab", { name: "Passkey" }).count()) === 0,
    "no tab for a method that was never enrolled",
  );
  check(
    /1 · Key/.test(locked) && /2 · Authenticator code/.test(locked),
    "the code is announced as step 2 before the PIN is typed",
  );
  check(
    (await page
      .getByRole("button", { name: "Skip to the guest vault" })
      .count()) === 1,
    "guest stays offered on the locked screen",
  );
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // Short PINs unwrap at up to 10M PBKDF2 iterations (PIN KDF cost scaling);
  // give the derivation plus the self-supplied second step room on slow CI.
  await page.waitForTimeout(8000);
  await finishUnlockSelfSupplied(page, "1-guest", { check, snap });
}

export async function guestUnlockAfterReload(
  page,
  { check, snap, PIN, ORIGIN, BASE },
) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const reloaded = await snap(page, "1-guest-reloaded");
  check(/^Unlock$/m.test(reloaded), "a reload lands on Unlock");
  check(
    /2 · Authenticator code/.test(reloaded),
    "step 2 is announced after a reload",
  );
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // Short PINs unwrap at up to 10M PBKDF2 iterations (PIN KDF cost scaling);
  // give the derivation plus the self-supplied second step room on slow CI.
  await page.waitForTimeout(8000);
  await finishUnlockSelfSupplied(page, "1-guest-reload", { check, snap });
}
