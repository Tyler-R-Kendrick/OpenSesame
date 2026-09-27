/**
 * Reach the Wallet the way a person does today.
 *
 * `wallet.spending` is an optional capability (ADR 0130): a fresh device's
 * plan does not include it, so the rail has no Wallet link until someone
 * turns it on in Settings › Capabilities and applies the plan. A fixture
 * cannot write that choice — the consent receipt binds exposure digests and
 * a forged one is refused — so this walks the real switch and Apply, inside
 * the same session. A reload would lock the guest vault, so every step is a
 * click, never a `goto`.
 */

import {
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "../../../apps/pages/scripts/lib/always-on.mjs";

const WALLET = "Wallet";

/** Turn Wallet on through Settings › Capabilities and Apply. */
export async function chooseWallet(page, check) {
  await page.locator('a[href$="/settings"]').first().click();
  await page
    .getByRole("link", { name: "Capabilities", exact: true })
    .first()
    .click();
  await awaitCapabilitySections(page);
  const add = capabilityOffSwitch(page, WALLET);
  if ((await add.count()) > 0) {
    await add.click();
    const apply = page.getByTestId("capability-apply");
    await apply.waitFor({ state: "visible", timeout: 15000 });
    await apply.click();
    await page
      .getByTestId("capability-review")
      .waitFor({ state: "detached", timeout: 20000 });
  }
  const on = capabilityOnSwitch(page, WALLET);
  await on.waitFor({ state: "attached", timeout: 20000 }).catch(() => {});
  check(
    (await on.count()) === 1,
    "Wallet capability is approved through Settings › Capabilities",
  );
}

/** Choose Wallet, then open it from the rail. */
export async function openWallet(page, check) {
  await chooseWallet(page, check);
  await page.locator('a[href$="/wallet"]').first().click();
}

/** Load the static origin and take the guest road to an unlocked vault. */
export async function enterAsGuest(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  const guest = page.getByRole("button", {
    name: "Continue as guest",
    exact: true,
  });
  await guest.waitFor({ state: "visible", timeout: 20000 });
  await guest.click();
  await guest.waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForTimeout(500);
}
