/**
 * Navigation the authentication walk shares between its journeys: into
 * Settings › Security, and the lock key. `onFailure` lets the walk keep its own
 * record (screenshots, log) when Settings cannot be reached.
 */
import { openSessionSection } from "./session-section.mjs";

export async function openSecurity(page, onFailure) {
  try {
    await openSessionSection(page, "Settings");
  } catch (error) {
    await onFailure?.();
    throw error;
  }
  await page.waitForTimeout(600);
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("link", { name: /^security/i })
    .first()
    .click();
  await page.waitForTimeout(600);
}

export async function lock(page) {
  // Two profile lock buttons exist (phone header, desktop rail); only one is
  // visible at any width.
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .click();
  await page.waitForTimeout(800);
}

/** The bound the walk's other arrivals keep (Seal with passkey, `waitOpen`). */
const ARRIVAL_MS = 20_000;

/**
 * Wait until `locator` is on screen, within the arrival bound. True once it
 * is; false when the bound runs out, so the checks that follow record it.
 */
export function arrives(locator) {
  return locator
    .first()
    .waitFor({ timeout: ARRIVAL_MS })
    .then(
      () => true,
      () => false,
    );
}

/**
 * A reload's arrival on the lock screen: the Unlock heading is drawn and no
 * unlock is in flight. True once both hold; false when the bound runs out, so
 * the check that follows records the failure.
 */
export async function unlockArrival(page) {
  const deadline = performance.now() + ARRIVAL_MS;
  const left = () => Math.max(1, deadline - performance.now());
  const busy = page
    .getByText("Unlocking…", { exact: true })
    .or(page.getByRole("button", { name: "Unlocking…", exact: true }));
  try {
    await page
      .getByRole("heading", { name: "Unlock", exact: true, level: 1 })
      .waitFor({ timeout: left() });
    await busy.waitFor({ state: "hidden", timeout: left() });
    return true;
  } catch {
    return false;
  }
}
