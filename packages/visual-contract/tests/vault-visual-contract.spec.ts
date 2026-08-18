/**
 * Visual contract for the six .impeccable/screenshots baselines, reproduced
 * against a live apps/pages build/preview (see ../playwright.config.ts).
 *
 * Selectors and flow are taken from current source, not the retired PIN-first
 * UnlockPage:
 *  - apps/pages/src/App.tsx              (lock gate before Routes)
 *  - apps/pages/src/screens/UnlockScreen.tsx (.unlock__card, #master / #confirm)
 *  - apps/pages/src/sections/VaultSection.tsx (.vault list after unlock)
 *  - apps/pages/src/components/AppShell.tsx (Vault nav after unlock)
 *
 * Every test gets a fresh Playwright browser context, so apps/pages always
 * sees a true first run: vault status is "empty". First-run create is a
 * master password (≥12 chars, strength score ≥2) plus the recovery checkbox.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { captureAndVerify } from "../src/compare.js";

/** Matches apps/pages store tests; length ≥12 and strength score ≥2. */
const MASTER_PASSWORD = "correct horse battery staple";

async function settleFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation: none !important; transition: none !important; }";
    const mount = () => document.head.append(style);
    if (document.head) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  });
});

async function completeFirstRunUnlock(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".unlock__card").waitFor({ state: "visible" });

  await page.locator("#master").fill(MASTER_PASSWORD);
  await page.locator("#confirm").fill(MASTER_PASSWORD);
  await page
    .getByLabel("I understand this vault cannot be recovered.")
    .check();
  await page.getByRole("button", { name: "Seal this device" }).click();

  await page.locator(".vault").waitFor({ state: "visible" });
  await page
    .getByRole("heading", { name: "All items" })
    .waitFor({ state: "visible" });

  await settleFonts(page);
}

test.describe("Authority Vault visual contract", () => {
  test("pages: initial app shell on load", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.locator(".unlock__card").waitFor({ state: "visible" });
    await settleFonts(page);
    await captureAndVerify(page, `pages-${testInfo.project.name}`, testInfo);
  });

  test("vault-unlock: first-run master-password form, settled", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await page.locator(".unlock__card").waitFor({ state: "visible" });
    await expect(
      page.getByRole("heading", { name: "Seal this device" }),
    ).toBeVisible();
    await expect(page.locator("#master")).toBeVisible();
    await expect(page.locator("#confirm")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Seal this device" }),
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
    await expect(page.locator(".vault")).toBeVisible();
    await captureAndVerify(
      page,
      `vault-list-${testInfo.project.name}`,
      testInfo,
    );
  });
});
