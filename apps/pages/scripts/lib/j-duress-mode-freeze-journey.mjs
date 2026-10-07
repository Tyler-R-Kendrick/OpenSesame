/**
 * J-DURESS-FREEZE: the "Freeze for a while" duress mode (ADR 0168), in the
 * built app with nothing mocked.
 *
 * The owner arms it for 24 hours in Settings › Security, reloads, and types
 * the code at the unlock screen. It is refused with exactly the words an
 * ordinary wrong password gets. The vault's real password is then refused the
 * same way, still so after another reload, and opens only once the page's
 * clock has passed the hold. Nothing on the device can clear the hold early.
 *
 * The page's clock is moved by a test-side shim that rides `window.name` (it
 * survives a reload and the app never reads it); the app has no clock seam.
 */
import {
  PIN,
  lockVault,
  openSettingsCategory,
  sealWithPin,
  waitOpen,
} from "./pages-journey.mjs";
import { takeRefusal } from "./tray-contract.mjs";

const CODE = "246813579";
const DAY_MS = 24 * 3_600_000;

/** Shifts `Date` by the milliseconds `window.name` carries as `os-clock:<ms>`. */
function installClockShim() {
  const Real = Date;
  const shift = () => {
    const match = /os-clock:(-?\d+)/.exec(window.name);
    return match ? Number(match[1]) : 0;
  };
  class Shifted extends Real {
    constructor(...args) {
      if (args.length === 0) super(Real.now() + shift());
      else super(...args);
    }
    static now() {
      return Real.now() + shift();
    }
  }
  window.Date = Shifted;
}

async function attempt(page, secret) {
  await page.getByLabel("PIN", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // The refusal is a notice in the tray, never a box in the page.
  return takeRefusal(page);
}

async function opened(page) {
  return (
    (await page
      .getByRole("button", { name: "Lock vault" })
      .locator("visible=true")
      .count()) > 0
  );
}

async function reloadToUnlock(page) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("PIN", { exact: true }).waitFor({ timeout: 15000 });
}

/** Freeze for 24 hours, chosen in the sheet: duration and consent, both explicit. */
async function arm({ page, check, snap }) {
  await openSettingsCategory(page, "Security");
  await page.locator("#duress-profiles").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Add" }).last().click();
  const fields = page.locator("[role=dialog] input[type=password]");
  await fields.nth(0).fill(CODE);
  await fields.nth(1).fill(CODE);
  const radios = await page.locator("[role=dialog] input[type=radio]").count();
  check(
    radios >= 3 &&
      (await page
        .getByRole("radio", { name: "Freeze for a while" })
        .count()) === 1,
    `the sheet offers Freeze among at least three modes (saw ${radios})`,
  );
  await page.getByRole("radio", { name: "Freeze for a while" }).check();
  const go = page.getByRole("button", { name: "Turn on duress code" });
  await page.getByRole("checkbox").check();
  check(
    await go.isDisabled(),
    "with the consent ticked and no duration chosen the key stays off",
  );
  const durations = page.getByRole("radio", {
    name: /^(1 hour|24 hours|72 hours)$/,
  });
  check(
    (await durations.count()) === 3,
    "three durations are offered: 1, 24 and 72 hours",
  );
  check(
    (await durations.evaluateAll((nodes) => nodes.some((n) => n.checked))) ===
      false,
    "no duration is chosen until the person chooses one",
  );
  await page.getByRole("radio", { name: "24 hours" }).check();
  check(await go.isEnabled(), "a duration and the consent turn the key on");
  await snap(page, "J-DURESS-FREEZE-sheet");
  await go.click();
  await page.getByText("Duress code is on.").waitFor({ timeout: 15000 });
}

export async function walkJDuressFreeze(context) {
  const { page, origin, base, check } = context;
  await page.context().addInitScript(installClockShim);
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);

  // What an ordinary wrong PIN says, before anything is armed: a well-formed
  // one, so the refusal is the vault's and not the field's format rule.
  await lockVault(page);
  const ordinary = await attempt(page, "73920146");
  check(ordinary.length > 0, `an ordinary wrong PIN says: ${ordinary}`);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);

  await arm(context);

  // The code, typed after a reload: the hold record must come back from disk.
  await reloadToUnlock(page);
  const viaCode = await attempt(page, CODE);
  check(
    viaCode === ordinary,
    `the code is refused in the ordinary words (${viaCode} vs ${ordinary})`,
  );
  check(
    !/freeze|frozen|hold|duress|decoy|guest/i.test(viaCode),
    "the refusal names nothing about a freeze",
  );

  const real = await attempt(page, PIN);
  check(
    real === ordinary,
    `the real PIN is refused in the ordinary words (${real})`,
  );
  check(!(await opened(page)), "the real PIN opens nothing while frozen");

  // The hold is on disk, not in the tab.
  await reloadToUnlock(page);
  const again = await attempt(page, PIN);
  check(again === ordinary, "after a reload the real PIN is still refused");
  check(!(await opened(page)), "after a reload the vault is still shut");

  // The clock passes the hold; nothing else changes.
  await page.evaluate((ms) => {
    window.name = `os-clock:${ms}`;
  }, DAY_MS + 60_000);
  await reloadToUnlock(page);
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
  check(await opened(page), "past the hold the real PIN opens the vault");
}
