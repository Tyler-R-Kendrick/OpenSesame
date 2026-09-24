// Prove the Access path bar's import and export work as a guest with no Host.
//
//   pnpm --filter @opensesame/pages dev:web   # :5180
//   PLAYWRIGHT_CHROMIUM=/path/to/chrome \
//     pnpm --filter @opensesame/pages verify:access-pathbar
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.PAGES_ORIGIN ?? "http://localhost:5180";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const chrome =
  process.env.PLAYWRIGHT_CHROMIUM ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1232/chrome-linux/chrome`;
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

const launch = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
if (fs.existsSync(chrome)) launch.executablePath = chrome;

const browser = await chromium.launch(launch);
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  serviceWorkers: "block",
  acceptDownloads: true,
});
const page = await context.newPage();
page.on("pageerror", (error) =>
  failures.push(`PAGE-ERROR ${String(error?.stack ?? error).slice(0, 400)}`),
);

await page.goto(`${ORIGIN}${BASE}`, {
  waitUntil: "domcontentloaded",
  timeout: 15000,
});
await page
  .getByRole("button", { name: "Continue as guest", exact: true })
  .first()
  .click();
await page.waitForSelector(".railtree", { timeout: 15000 });

const accessRail = page.locator('[data-rail-to="/access"]');
check((await accessRail.count()) > 0, "Access is on the rail");
await accessRail.click();
await page
  .getByRole("heading", { name: "Access", exact: true })
  .waitFor({ timeout: 10000 });
await page.screenshot({ path: path.join(OUT, "01-access.png") });

const toolbar = page.getByRole("toolbar", { name: "Access actions" });
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
  await page.getByRole("button", { name: "Grant identity share" }).isVisible(),
  "the grants tab's + is the identity share's",
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
await page
  .getByRole("heading", { name: "Imported grant" })
  .waitFor({ timeout: 5000 });
check(true, "imported grant listed");
check(
  (await toolbar.getByRole("img", { name: "Imported 1 grant" }).count()) === 1,
  "import says what it did",
);
await page.screenshot({ path: path.join(OUT, "03-imported.png") });

const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
await toolbar.getByRole("button", { name: "Export grants" }).click();
const download = await downloadPromise;
const exported = await download.path();
const raw = fs.readFileSync(exported, "utf8");
check(raw.includes("Imported grant"), "export contains imported grant");
await page.screenshot({ path: path.join(OUT, "04-exported.png") });

await browser.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("access pathbar e2e ok");
