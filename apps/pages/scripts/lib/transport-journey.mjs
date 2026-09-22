/**
 * The steps `verify-transport.mjs` takes, named after what a person does:
 * enter as guest, reach a section, open Settings › Security › Transport,
 * read a row's tone, walk the keyboard, and measure what is on screen.
 * The checks stay in the verifier; this is the machinery.
 */

/** Copy the panel must never show: an erasure, a TLS gate on the vault, a place. */
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
  await press(
    page.getByRole("button", { name: "Continue as guest", exact: true }),
    touch,
  );
  await page.waitForTimeout(1500);
}

/** A rail section (`settings/`, `vault/`) the way this width reaches it. */
export async function openSection(page, label, touch = false) {
  const sections = page.getByRole("button", { name: "Sections" }).first();
  if (await sections.count()) {
    await press(sections, touch);
    await page.waitForTimeout(400);
    const row = page
      .locator(".drawer__row", { hasText: label.replace("/", "") })
      .first();
    await press(row, touch);
  } else {
    const link = page
      .getByRole("link", { name: new RegExp(`^${label.replace("/", "\\/")}`) })
      .first();
    if (await link.count()) await press(link, touch);
    else await press(page.getByText(label, { exact: true }).first(), touch);
  }
  await page.waitForTimeout(700);
}

/** Settings › Security, then the panel scrolled into view. */
export async function openTransport(page, touch = false) {
  await openSection(page, "settings/", touch);
  const security = page
    .getByRole("link", { name: "Security", exact: true })
    .last();
  await press(security, touch);
  const panel = page.locator("#transport");
  await panel.waitFor({ timeout: 15_000 });
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  return panel;
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
