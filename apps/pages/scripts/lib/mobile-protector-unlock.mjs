/**
 * The unlock screen a phone sees for a vault with an enrolled recovery key
 * (ADR 0152): the extra tab, its field, and the second tab row all measured
 * against the touch contract — the 44px keys, the 16px field, nothing hidden
 * in a strip. A PIN vault is sealed in the touch context, a recovery key
 * is enrolled from Settings, and the vault is locked; every stop is audited
 * by the walk's own `audit`, so a regression here fails the same gate.
 */
import fs from "node:fs";
import { emulateFilePickers } from "./file-pickers.mjs";
import { passTheDoor } from "./front-door.mjs";
import { waitOpen } from "./pages-journey.mjs";

export const PIN = "48291037";

/** The no-account road behind the door, sealed with a device PIN (ADR 0180). */
export async function sealWithPin(page) {
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).tap();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "PIN" }).tap();
  await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).tap();
  await waitOpen(page);
}

/** Settings › Security, reached the way a thumb does. */
async function openSecurity(page, openTab) {
  await openTab(page, "Settings");
  await page.waitForTimeout(700);
  const security = page
    .getByRole("link", { name: "Security", exact: true })
    .first();
  await security.waitFor({ state: "visible", timeout: 15000 });
  await security.tap();
}

export async function protectorUnlockStops(
  page,
  { harness, audit, openTab, stop, origin, base },
) {
  // Drive the native save seam as a person accepting its picker; enrollment
  // still writes and closes the actual generated key before committing.
  await emulateFilePickers(page.context());
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await openSecurity(page, openTab);
  harness.setStep(stop("unlock-protectors"));
  const add = page.getByRole("button", { name: "Add key protection method" });
  await add
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => undefined);
  if (!(await add.isVisible().catch(() => false))) {
    harness.check(false, `${stop("unlock-protectors")}: Add is not reachable`);
    return;
  }
  await add.tap();
  await page.waitForTimeout(500);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Recovery key", exact: true })
      .tap(),
  ]);
  const key = fs.readFileSync(await download.path(), "utf8").trim();
  await page.waitForTimeout(1500);
  await audit(page, stop("protector-enrolled"));
  await page.getByRole("button", { name: "Lock vault" }).first().tap();
  await page.waitForTimeout(900);
  const tab = page.getByRole("tab", { name: "Recovery key" });
  harness.check(
    (await tab.count()) === 1,
    `${stop("unlock-protectors")}: the Recovery key tab is drawn`,
  );
  await tab.tap();
  await page.waitForTimeout(400);
  await audit(page, stop("unlock-protectors"));
  await page.getByLabel("Recovery key", { exact: true }).fill(key);
  await audit(page, stop("unlock-protectors-typed"));
}
