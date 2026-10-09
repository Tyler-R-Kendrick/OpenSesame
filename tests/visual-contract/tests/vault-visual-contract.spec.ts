/**
 * Visual contract for the six .impeccable/screenshots baselines, reproduced
 * against a live apps/pages build/preview (see ../playwright.config.ts).
 *
 * The flow is the one a first visitor walks today (ADR 0090, ADR 0115,
 * ADR 0150):
 *  - apps/pages/src/app-root.tsx            (the gate before the shell)
 *  - apps/pages/src/screens/FrontDoor.tsx   (.door: Set up your own, Join a
 *                                            session, and the corner Skip;
 *                                            sign-in and "Use without an
 *                                            account" once setup is skipped)
 *  - apps/pages/src/screens/UnlockScreen.tsx (.unlock__card, protection tabs)
 *  - apps/pages/src/sections/VaultSection.tsx (.vault after sealing)
 *
 * Every test gets a fresh Playwright browser context, so apps/pages always
 * sees a true first run: no vault and no setup record, so the front door.
 * The local-only seal offers a device PIN on this IP-address preview origin
 * (ADR 0180); the journey acknowledges that it has no recovery.
 *
 * Pages calls no backend by default (ADR 0090: every settings default is
 * empty), so nothing here is mocked. Instead any request that leaves the
 * preview origin, and any uncaught page error, fails the test: a capture of
 * a screen that tried to reach a service is not a capture of the product.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { captureAndVerify } from "../src/compare.js";

/** Matches the real Pages browser journeys and the PIN enrollment rules. */
const DEVICE_PIN = "48291037";

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
 * with no identity at all. It is a sign-in road, so it sits behind the front
 * door's setup road (ADR 0150 §1): Set up your own, Skip all, then sign-in.
 */
async function openLocalOnlySeal(page: Page): Promise<void> {
  await openFrontDoor(page);
  await page.getByRole("button", { name: "Set up your own" }).click();
  await page.getByRole("button", { name: "Skip all" }).click();
  await page.getByRole("button", { name: "Use without an account" }).click();
  await expect(
    page.getByRole("tab", { name: "PIN", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#master")).toHaveCount(0);
}

async function completeFirstRunSeal(
  page: Page,
  mobile: boolean,
): Promise<void> {
  await openLocalOnlySeal(page);

  await page.getByRole("tab", { name: "PIN", exact: true }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(DEVICE_PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(DEVICE_PIN);
  await page.getByLabel("I understand this vault cannot be recovered.").check();
  await page
    .getByRole("button", { name: "Seal with PIN", exact: true })
    .click();

  await page.locator(".vault").waitFor({ state: "visible" });
  await expect(
    page.getByRole("button", { name: "Lock vault", exact: true }),
  ).toBeVisible();
  const empty = page.getByRole("heading", {
    name: "Nothing here",
    exact: true,
    includeHidden: true,
  });
  await expect(empty).toHaveCount(1);
  if (mobile) {
    // Main's phone landing draws its section tree; the empty list stays mounted behind it.
    await expect(empty).toBeHidden();
    const sections = page.getByRole("tree", { name: "Sections", exact: true });
    await expect(sections).toBeVisible();
    await expect(
      sections.getByRole("treeitem", { name: "Vault", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      sections.getByRole("treeitem", { name: "all", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("link", { name: "New item", exact: true }),
    ).toBeVisible();
    await sections.getByRole("treeitem", { name: "all", exact: true }).click();
    await page
      .locator(".vault[data-pane='list']")
      .waitFor({ state: "visible" });
    await expect(empty).toBeVisible();
  } else {
    await expect(empty).toBeVisible();
  }
}

test.describe("Pages visual contract", () => {
  test("pages: front door on a fresh device", async ({ page }, testInfo) => {
    await openFrontDoor(page);
    // Two roads and nothing in front of them (ADR 0090, ADR 0150 §1); the
    // guest road is load-bearing (AGENTS.md §5) and is the corner Skip.
    await expect(
      page.getByRole("button", { name: /Set up your own/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Join a session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Skip sign-in and continue as guest" }),
    ).toBeVisible();
    await capture(
      page,
      page.locator(".door .unlock__card"),
      `pages-${testInfo.project.name}`,
      testInfo,
    );
  });

  test("vault-unlock: first-run device-PIN form, settled", async ({
    page,
  }, testInfo) => {
    await openLocalOnlySeal(page);
    await expect(
      page.getByRole("heading", { name: "Seal this device" }),
    ).toBeVisible();
    const pin = page.getByLabel("Device PIN", { exact: true });
    await expect(pin).toBeVisible();
    await expect(page.getByLabel("Confirm PIN", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "PIN", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#master")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Seal with PIN", exact: true }),
    ).toBeVisible();
    await capture(page, pin, `vault-unlock-${testInfo.project.name}`, testInfo);
  });

  test("vault-list: vault landing page after sealing", async ({
    page,
    isMobile,
  }, testInfo) => {
    await completeFirstRunSeal(page, isMobile ?? false);
    await capture(
      page,
      page.locator(".vault"),
      `vault-list-${testInfo.project.name}`,
      testInfo,
    );
  });
});
