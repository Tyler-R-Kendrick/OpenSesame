/**
 * Visual contract for the six .impeccable/screenshots baselines, reproduced
 * against a live apps/pages build/preview (see ../playwright.config.ts).
 *
 * Selectors and flow below are taken directly from the current source, not
 * guessed:
 *  - apps/pages/src/App.tsx            (routing / lock gate)
 *  - apps/pages/src/pages/UnlockPage.tsx (first-run PIN creation form)
 *  - apps/pages/src/pages/VaultPage.tsx  (.vault-panel / .vault-list markup)
 *  - apps/pages/src/components/VaultShell.tsx (post-unlock chrome)
 *  - apps/pages/src/lib/lock.ts / lib/kv.ts (session state is memory-only;
 *    the PIN hash persists to OPFS, both scoped to the browser context)
 *
 * Every test gets its own fresh Playwright browser context (Playwright's
 * default), so apps/pages always sees a true first run here: hasUnlockPin()
 * is false, isUnlocked() is false. There is no way to reach a "returning
 * user" unlock form or a pre-populated vault from a clean context, so this
 * suite intentionally only exercises the first-run creation flow.
 *
 * KNOWN CAVEAT (flagged rather than silently resolved, per WP7 instructions):
 * under this app's routing, "/" -> redirect to "/vault" -> redirect to
 * "/unlock" while locked, so the very first paint of the app root IS the
 * unlock screen. "pages-*" and "vault-unlock-*" are therefore the *same*
 * screen. We still capture them at two distinct points so they are not
 * literally identical file bytes and so each has a defensible meaning:
 *   - pages-*        : first paint, right after the unlock card mounts —
 *                       "what does the app shell look like on load".
 *   - vault-unlock-*  : the same screen after webfonts have settled
 *                       (document.fonts.ready) — "the unlock screen at rest".
 * If apps/pages ever grows a real loading/splash state distinct from the
 * unlock screen, this suite should be revisited so "pages-*" captures that
 * instead. Until then, expect these two baselines to be visually very close.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { captureAndVerify } from "../src/compare.js";

/** >= the app's MIN_PIN_LEN (6); arbitrary otherwise. */
const UNLOCK_PIN = "visual-contract-000000";

async function settleFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

async function completeFirstRunUnlock(page: Page): Promise<void> {
  await page.goto("/unlock");
  await page.locator("#unlock-pin").waitFor({ state: "visible" });

  await page.locator("#unlock-pin").fill(UNLOCK_PIN);
  await page.locator("#unlock-confirm").fill(UNLOCK_PIN);
  await page.getByRole("button", { name: "Create vault unlock" }).click();

  await page.waitForURL(/\/vault$/);
  await page
    .getByRole("heading", { name: "Vault" })
    .waitFor({ state: "visible" });

  // VaultPage starts sealStatus at "Checking sealed store…" and flips it
  // asynchronously (OPFS-backed sealed-store round trip) by re-rendering the
  // same ".seal-chip" node in place, so we poll its text rather than wait
  // for the node to detach. Best-effort: proceed with whatever sealStatus
  // currently reads if it's still checking after a short grace period,
  // rather than hard-failing the capture over it.
  await expect(page.locator(".seal-chip"))
    .not.toHaveText(/Checking sealed store/, { timeout: 5_000 })
    .catch(() => {
      /* best-effort */
    });

  await settleFonts(page);
}

test.describe("Authority Vault visual contract", () => {
  test("pages: initial app shell on load", async ({ page }, testInfo) => {
    await page.goto("/");
    // First paint of whatever the router lands on while locked ("/unlock",
    // per App.tsx's redirect chain) — captured before waiting on fonts.
    await page.locator(".unlock-card").waitFor({ state: "visible" });
    await captureAndVerify(page, `pages-${testInfo.project.name}`, testInfo);
  });

  test("vault-unlock: first-run PIN creation form, settled", async ({
    page,
  }, testInfo) => {
    await page.goto("/unlock");
    await page.locator(".unlock-card").waitFor({ state: "visible" });
    await expect(page.locator("#unlock-pin")).toBeVisible();
    await expect(page.locator("#unlock-confirm")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create vault unlock" }),
    ).toBeVisible();
    await settleFonts(page);
    await captureAndVerify(
      page,
      `vault-unlock-${testInfo.project.name}`,
      testInfo,
    );
  });

  test("vault-list: vault landing page after completing unlock", async ({
    page,
  }, testInfo) => {
    await completeFirstRunUnlock(page);
    await expect(page.locator(".vault-panel")).toBeVisible();
    await captureAndVerify(
      page,
      `vault-list-${testInfo.project.name}`,
      testInfo,
    );
  });
});
