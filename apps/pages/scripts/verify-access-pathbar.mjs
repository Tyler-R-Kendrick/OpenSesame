// Prove the Access path bar's import and export work as a guest with no Host.
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=/path/to/chrome \
//     pnpm --filter @opensesame/pages verify:access-pathbar
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import {
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./lib/always-on.mjs";
import { doorGuest } from "./lib/front-door.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "access-pathbar"),
);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function check(condition, what) {
  if (!condition) failures.push(what);
  console.log(condition ? `PASS  ${what}` : `FAIL  ${what}`);
}

const harness = createHarness({
  dist: process.env.PAGES_VERIFY_DIST ?? path.join(here, "..", "dist"),
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const browser = await harness.launch({
  args: ["--no-sandbox", "--disable-gpu"],
});
const { page } = await harness.newPage(browser);
await page.setViewportSize({ width: 1280, height: 800 });
page.on("pageerror", (error) =>
  failures.push(`PAGE-ERROR ${String(error?.stack ?? error).slice(0, 400)}`),
);

await page.goto(`${ORIGIN}${BASE}`, {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await doorGuest(page).click();
await page.waitForSelector(".railtree", { timeout: 15000 });

// Access is an optional extension (ADR 0153). The path bar exists once the
// person turns Access authority on.
await page.keyboard.press("Escape");
await page.keyboard.press("g");
await page.keyboard.press("s");
await expect(page).toHaveURL(/\/settings(?:[/?].*)?$/);
await page.getByRole("link", { name: "Capabilities", exact: true }).click();
await awaitCapabilitySections(page);
const accessOn = capabilityOnSwitch(page, "Access authority");
if ((await accessOn.count()) === 0) {
  const addAccess = capabilityOffSwitch(page, "Access authority");
  await expect(addAccess).toHaveCount(1);
  await addAccess.click();
}
await expect(capabilityOnSwitch(page, "Access authority")).toHaveCount(1, {
  timeout: 15000,
});
await page.keyboard.press("Escape");
await page.keyboard.press("g");
await page.keyboard.press("v");
await expect(page).toHaveURL(/\/vault$/);
const accessRail = page.locator('[data-rail-to="/access"]');
await accessRail.waitFor({ timeout: 15000 });
check((await accessRail.count()) > 0, "Access is on the rail once chosen");
await accessRail.click();
await expect(
  page.locator('.record-workspace[data-section="Access"]'),
).toBeVisible();
await expect(
  page.getByRole("tree", {
    name: "Local application grants items",
    exact: true,
  }),
).toBeVisible();
await page.screenshot({ path: path.join(OUT, "01-access.png") });

const strip = page.locator(".record-workspace .vtree__pathbar");
const toolbar = strip.getByRole("toolbar", { name: "Access actions" });
check(await toolbar.isVisible(), "book controls occupy the list path strip");
check(
  (await page.locator(".section__head").count()) === 0,
  "no separate Access page header",
);
// The path bar holds the access book's two keys. Its + opened a Host grant
// ceremony that no longer exists; each panel's own + adds its kind.
check(
  (await toolbar.getByRole("link").count()) === 0,
  "no key that only changes the path",
);
check((await toolbar.getByLabel("Import grants").count()) === 1, "import key");
check(
  await toolbar.getByRole("button", { name: "Export grants" }).isVisible(),
  "export key",
);
check(
  await strip
    .getByRole("button", { name: "Reload local access records" })
    .isVisible(),
  "the list's own command shares the path strip",
);

const book = JSON.stringify({
  version: 1,
  grants: [
    {
      id: "gr_local_imported",
      title: "Imported grant",
      claimant: "local",
      resource: "local",
      actions: [],
      mode: "broker",
      expiresAt: "2026-09-04T00:00:00Z",
    },
  ],
});
const bookPath = path.join(os.tmpdir(), "access-book.json");
fs.writeFileSync(bookPath, book);
await toolbar.getByLabel("Import grants").setInputFiles(bookPath);
await expect(
  toolbar.getByRole("img", { name: "Imported 1 grant" }),
).toBeVisible();
check(
  (await toolbar.getByRole("img", { name: "Imported 1 grant" }).count()) === 1,
  "import says what it did",
);
const grants = page.getByRole("treeitem", { name: "Grants", exact: true });
if ((await grants.getAttribute("aria-expanded")) !== "true")
  await grants.click();
await page
  .getByRole("treeitem", { name: "Portable grants", exact: true })
  .click();
const imported = page
  .getByRole("tree", { name: "Portable grants items", exact: true })
  .getByRole("treeitem", { name: /^Imported grant/ });
await expect(imported).toBeVisible();
check(true, "imported grant listed as a compact record");
await imported.click();
await expect(
  page.getByRole("heading", { name: "Imported grant", exact: true }),
).toBeVisible();
check(true, "imported grant opens its ruled detail");
await page.screenshot({ path: path.join(OUT, "03-imported.png") });

const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
await toolbar.getByRole("button", { name: "Export grants" }).click();
const download = await downloadPromise;
const exported = await download.path();
const raw = fs.readFileSync(exported, "utf8");
const exportedBook = JSON.parse(raw);
check(
  exportedBook.version === 1 &&
    exportedBook.grants.some(
      (grant) =>
        grant.id === "gr_local_imported" &&
        grant.title === "Imported grant" &&
        grant.resource === "local",
    ),
  "export retains the imported grant's reference and fields",
);
await page.screenshot({ path: path.join(OUT, "04-exported.png") });

await browser.close();
fs.rmSync(bookPath, { force: true });
failures.push(
  ...harness.log
    .filter((entry) =>
      ["PAGE-ERROR", "MISSING-ASSET", "LOOPBACK-REQUEST"].includes(entry.kind),
    )
    .map((entry) => `${entry.kind} ${entry.detail}`),
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("access pathbar e2e ok");
