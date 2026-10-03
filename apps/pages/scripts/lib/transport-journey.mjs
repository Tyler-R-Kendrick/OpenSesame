/**
 * The steps `verify-transport.mjs` takes, named after what a person does:
 * enter as guest, reach a section, open Settings › Security, and measure
 * that the page draws no Transport panel.
 * The checks stay in the verifier; this is the machinery.
 */

/** Copy the panel must never show: an erasure, a TLS gate on the vault, a place. */
import { doorGuest } from "./front-door.mjs";
import { openSessionSection } from "./session-section.mjs";

export const NO_SUCH_CLAIM =
  /erased|wiped|deleted your|TLS-gated|certificate to unlock|unlock requires|requires a certificate|127\.0\.0\.1|localhost/i;

export const DIMENSIONS = [
  "desired",
  "credential",
  "runtime",
  "observed",
  "enforcement",
];

async function press(locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

export async function guest(page, origin, base, touch = false) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await press(doorGuest(page), touch);
  await page.waitForTimeout(1500);
}

/** A section the way this width reaches it. Settings is a session root. */
export async function openSection(page, label, touch = false) {
  const session =
    label === "settings/"
      ? "Settings"
      : label === "activity/"
        ? "Activity"
        : null;
  if (session) {
    const sections = page.getByRole("button", { name: "Sections" });
    if (await sections.isVisible().catch(() => false)) {
      await press(sections, touch);
      await page.waitForTimeout(400);
      await press(
        page.getByRole("link", { name: session, exact: true }),
        touch,
      );
    } else {
      await openSessionSection(page, session);
    }
    await page.waitForTimeout(700);
    return;
  }
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
  const row = page.locator(".railtree__row", { hasText: label }).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await press(row, touch);
  await page.waitForTimeout(700);
}

/** Settings › Security. The Transport panel is not on this page. */
export async function openSecurity(page, touch = false) {
  await openSection(page, "settings/", touch);
  await press(
    page.getByRole("link", { name: "Security", exact: true }).last(),
    touch,
  );
  await page.waitForTimeout(400);
}

/** The endpoint probe's key — drawn only while an endpoint is set. */
export function verifyKey(page) {
  return page.getByRole("button", { name: /enforcement verification/ });
}

export function tone(page, dimension) {
  return page
    .locator(`[data-dimension="${dimension}"]`)
    .getAttribute("data-tone");
}

export async function tabTo(page, target, key = "Tab") {
  for (let step = 0; step < 200; step += 1) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error(
    `${key} cannot reach ${await target.getAttribute("aria-label")}`,
  );
}

/** Geometry from the browser, never from the CSS we hoped shipped. */
export async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const panel = document.querySelector("#transport");
    const refresh = document.querySelector(
      '[aria-label="Refresh transport status"]',
    );
    const rows = [...document.querySelectorAll(".transport__row")];
    const select = document.querySelector("#transport-target");
    return {
      panel: panel ? rect(panel) : null,
      refresh: refresh ? rect(refresh) : null,
      rows: rows.map((row) => rect(row).h),
      tones: rows.map((row) => `${row.dataset.dimension}=${row.dataset.tone}`),
      selectFont: select ? getComputedStyle(select).fontSize : null,
      panels: document.querySelectorAll("main section.panel").length,
    };
  });
}
