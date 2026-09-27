/**
 * Visual contract for the six .impeccable/screenshots baselines, reproduced
 * against a live apps/pages build/preview (see ../playwright.config.ts).
 *
 * The flow is the one a first visitor walks today (ADR 0090, ADR 0115):
 *  - apps/pages/src/app-root.tsx            (the gate before the shell)
 *  - apps/pages/src/screens/FrontDoor.tsx   (.door: Set up your own, then the
 *                                            sign-in panel with guest and
 *                                            "Use without an account")
 *  - apps/pages/src/screens/UnlockScreen.tsx (.unlock__card, #master / #confirm)
 *  - apps/pages/src/sections/VaultSection.tsx (.vault after sealing)
 *
 * Every test gets a fresh Playwright browser context, so apps/pages always
 * sees a true first run: no vault and no setup record, so the front door.
 * The local-only seal is a master password (≥12 chars, strength score ≥2)
 * plus the no-recovery checkbox.
 *
 * Pages calls no backend by default (ADR 0090: every settings default is
 * empty), so nothing here is mocked. Instead any request that leaves the
 * preview origin, and any uncaught page error, fails the test: a capture of
 * a screen that tried to reach a service is not a capture of the product.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { captureAndVerify } from "../src/compare.js";

/** Matches apps/pages store tests; length ≥12 and strength score ≥2. */
const MASTER_PASSWORD = "correct horse battery staple";

async function settleFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/** Requests that left the preview origin, and uncaught page errors. */
const strays = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
  const seen: string[] = [];
  strays.set(page, seen);
  page.on("request", (request) => {
    const url = request.url();
    if (/^(data|blob):/.test(url)) return;
    if (new URL(url).origin !== origin) seen.push(`request ${url}`);
  });
  page.on("pageerror", (error) => seen.push(`pageerror ${error.message}`));
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation: none !important; transition: none !important; }";
    const mount = () => document.head.append(style);
    if (document.head) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  });
});

test.afterEach(({ page }) => {
  expect(strays.get(page) ?? [], "the screen reached past Pages").toEqual([]);
});

/**
 * Capture `name` while `landmark` is on screen, before and after, so a
 * screenshot of a page that went away mid-capture can never be compared (a
 * near-empty screen passes a mostly-empty baseline inside the budget).
 */
async function capture(
  page: Page,
  landmark: Locator,
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  await expect(landmark).toBeVisible();
  await settleFonts(page);
  await captureAndVerify(page, name, testInfo);
  await expect(landmark).toBeVisible();
}

/** The front door of an empty device (ADR 0115), settled. */
async function openFrontDoor(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".door .unlock__card").waitFor({ state: "visible" });
}

/**
 * The local-only road: "Use without an account" seals a vault on this device
 * with no identity at all. It sits on the front door beside the guest road.
 */
async function openLocalOnlySeal(page: Page): Promise<void> {
  await openFrontDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.locator("#master").waitFor({ state: "visible" });
}

async function completeFirstRunSeal(page: Page): Promise<void> {
  await openLocalOnlySeal(page);

  await page.locator("#master").fill(MASTER_PASSWORD);
  await page.locator("#confirm").fill(MASTER_PASSWORD);
  await page.getByLabel("I understand this vault cannot be recovered.").check();
  await page.getByRole("button", { name: "Seal this device" }).click();

  await page.locator(".vault").waitFor({ state: "visible" });
  // The pane has no heading; a fresh vault lands on the empty state
  // (apps/pages/src/sections/VaultSection.tsx).
  await page
    .getByRole("heading", { name: "Nothing here", exact: true })
    .waitFor({ state: "visible" });
}

test.describe("Pages visual contract", () => {
  test("pages: front door on a fresh device", async ({ page }, testInfo) => {
    await openFrontDoor(page);
    // Sign-in stays on the first screen and nothing gates it (ADR 0090); the
    // guest road is load-bearing (AGENTS.md §5) and must be on it.
    await expect(
      page.getByRole("button", { name: /Set up your own/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue as guest", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Use without an account", exact: true }),
    ).toBeVisible();
    await capture(
      page,
      page.locator(".door .unlock__card"),
      `pages-${testInfo.project.name}`,
      testInfo,
    );
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
    await capture(
      page,
      page.locator("#master"),
      `vault-unlock-${testInfo.project.name}`,
      testInfo,
    );
  });

  test("vault-list: vault landing page after sealing", async ({
    page,
  }, testInfo) => {
    await completeFirstRunSeal(page);
    await capture(
      page,
      page.locator(".vault"),
      `vault-list-${testInfo.project.name}`,
      testInfo,
    );
  });
});
