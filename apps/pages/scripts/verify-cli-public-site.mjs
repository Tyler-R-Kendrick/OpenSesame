// Prove CLI pairing on the public static site (P8-5 / FIX-BRIEF F5).
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   pnpm --filter @opensesame/pages verify:cli-public-site
//
// The Pages build is the one CI already produced (`scripts/lib/ci-pages-build.mjs`).
// This walk does not rebuild. A guest on https://opensesame-labs.github.io
// opens Identity › Devices, finds Pair CLI uncounted, and reaches Authorize
// CLI from the command bar. The pairing field stays hidden. The block is a
// status mark and a tray notice. Nothing calls loopback.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import { tabToAccessControl } from "./lib/local-access-journey.mjs";
import { openIdentityView } from "./lib/local-directory-navigation.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(
  process.env.PAGES_VERIFY_DIST ?? path.join(here, "..", "dist"),
);
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://opensesame-labs.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "cli-public-site"),
);

/** Keep in step with `CLI_AUTHORIZE_LOAD_BLOCKED`. */
const BLOCKED =
  "CLI pairing is optional and only works on your own deployment, where a passkey approves the terminal. Local CLI approval is blocked on this site.";

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { log, failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

async function suggest(page, typed) {
  const input = page.locator("#command-bar-input");
  await input.click();
  await input.fill(typed);
  const option = page.getByRole("option", { name: "Pair CLI" });
  await expect(option).toHaveCount(1);
  await expect(option).toBeVisible();
  return option;
}

const browser = await launch();
try {
  setStep("guest");
  const guest = await newPage(browser);
  const page = guest.page;
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);

  setStep("devices");
  await openIdentityView(page, tabToAccessControl, "Devices");
  const workspace = page.locator('.record-workspace[data-section="Identity"]');
  const list = workspace.getByRole("tree", { name: "Devices items" });
  const deviceRows = list
    .locator(".vtree__row")
    .filter({ has: page.locator(".vtree__dim", { hasText: /^\.device$/ }) });
  await expect.poll(async () => deviceRows.count()).toBeGreaterThan(0);
  const deviceCount = await deviceRows.count();
  await expect(
    list.getByRole("treeitem", { name: "Pair CLI", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("treeitem", { name: "Terminal CLI", exact: true }),
  ).toHaveCount(0);
  const meta = (
    await workspace.locator(".vault__status-meta").innerText()
  ).trim();
  check(
    meta === String(deviceCount),
    `the list counts ${deviceCount} devices and not Pair CLI (saw ${meta})`,
  );
  const buffer = workspace.locator(".buffer__line");
  check(
    (await buffer.count()) === 1 &&
      (await buffer.innerText()).trim() === `${deviceCount} devices`,
    "the empty detail counts devices only",
  );

  const rail = page.getByRole("tree", { name: "Sections", exact: true });
  const devicesBranch = rail.getByRole("treeitem", {
    name: "Devices",
    exact: true,
  });
  if ((await devicesBranch.getAttribute("aria-expanded")) !== "true") {
    await devicesBranch.focus();
    await page.keyboard.press("ArrowRight");
  }
  const kids = page.locator("#devices-tree");
  await expect(kids).toBeVisible();
  const railText = await kids.innerText();
  check(!railText.includes("Pair CLI"), "the rail does not list Pair CLI");
  check(
    !railText.includes("Terminal CLI"),
    "the rail does not list Terminal CLI",
  );
  const railCount = (
    await devicesBranch.locator(".railtree__count").innerText()
  ).trim();
  check(
    railCount === String(deviceCount),
    `the rail counts ${deviceCount} devices (saw ${railCount})`,
  );
  await snap(page, "devices");

  setStep("command-bar");
  for (const typed of ["/pair", "/cli", "/pair cli"]) {
    await suggest(page, typed);
    await page.keyboard.press("Escape");
  }
  const input = page.locator("#command-bar-input");
  await input.fill("pair");
  await expect(page.getByRole("listbox", { name: "Commands" })).toHaveCount(0);
  await page.getByRole("button", { name: "Run command" }).click();
  await page.waitForURL(/\/identity\/authorize\?cli=1/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Authorize CLI", exact: true }),
  ).toBeVisible();

  setStep("blocked");
  await expect(page.locator("#cli-authorize-pairing-code")).toHaveCount(0);
  await expect(page.getByRole("img", { name: BLOCKED })).toBeVisible();
  const bell = page
    .getByRole("button", { name: /^Notifications/ })
    .filter({ visible: true });
  if ((await bell.count()) === 0) {
    await page
      .getByRole("button", { name: /^More/ })
      .filter({ visible: true })
      .first()
      .click();
  }
  await bell.first().click();
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(BLOCKED);
  check(
    !(await page.locator("#cli-authorize-pairing-code").count()),
    "the pairing field stays hidden",
  );
  await snap(page, "authorize-blocked");

  await guest.context.close();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  for (const [index, context] of browser.contexts().entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      await page
        .screenshot({
          path: path.join(OUT, `failed-${index + 1}-${pageIndex + 1}.png`),
        })
        .catch(() => {});
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
for (const entry of log) {
  if (entry.kind === "PASS" || entry.kind === "FAIL") {
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
  }
}
const hard = log.filter((entry) =>
  [
    "LOOPBACK-REQUEST",
    "HTTP-ERROR",
    "PAGE-ERROR",
    "console-error",
    "ON-SCREEN",
    "MISSING-ASSET",
  ].includes(entry.kind),
);
for (const entry of hard) {
  console.log(`${entry.kind} [${entry.step}] ${entry.detail.slice(0, 240)}`);
}
if (failures.length > 0 || hard.length > 0) {
  console.error(
    `${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`cli-public-site ok — artifacts in ${OUT}`);
