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

async function mockPlaneApis(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:18787/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/health" || path === "/health/live") {
      await route.fulfill({ json: { status: "ok" } });
    } else if (path === "/api/v1/session/local") {
      await route.fulfill({
        json: {
          access_token: "opaque-session:visual-contract",
          expires_in: 3600,
          local_session: true,
        },
      });
    } else if (path === "/api/v1/sync/blobs/push") {
      await route.fulfill({
        status: 500,
        json: { error: "sync_storage_failed" },
      });
    } else if (path === "/api/v1/backup/target") {
      await route.fulfill({
        json: { target: { status: "active" }, pending_events: 4 },
      });
    } else {
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    }
  });
  await page.route("http://127.0.0.1:18788/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill(
      path === "/v1/health/live"
        ? { json: { status: "ok" } }
        : { status: 401, json: { error: "unauthorized" } },
    );
  });
}

test.beforeEach(async ({ page }) => {
  await mockPlaneApis(page);
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation: none !important; transition: none !important; }";
    const mount = () => document.head.append(style);
    if (document.head) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  });
});

/**
 * First run opens on the sign-in panel, not the seal form.
 *
 * ADR 0033 §4 puts identity before encryption, so the local-only road is an
 * explicit choice behind "Use without an account" rather than the first thing
 * a visitor sees. Every capture below that wants the seal form has to take
 * that road first; walking straight to `#master` was the old shape and is why
 * this suite went red when the sign-in flow was redesigned.
 */
async function openLocalOnlySeal(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".unlock__card").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.locator("#master").waitFor({ state: "visible" });
}

async function completeFirstRunUnlock(page: Page): Promise<void> {
  await openLocalOnlySeal(page);

  await page.locator("#master").fill(MASTER_PASSWORD);
  await page.locator("#confirm").fill(MASTER_PASSWORD);
  await page.getByLabel("I understand this vault cannot be recovered.").check();
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
    await openLocalOnlySeal(page);
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
