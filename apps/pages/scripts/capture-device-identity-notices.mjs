// Capture the two bell notices the device identity key raises (ADR 0160 §5a),
// from a real build, for the before/after sheets under
// docs/evidence/2026-10-04-device-identity-carry/.
//
//   EVIDENCE_DIST=<base worktree>/apps/pages/dist \
//     node apps/pages/scripts/capture-device-identity-notices.mjs before
//   node apps/pages/scripts/capture-device-identity-notices.mjs after
//   node apps/pages/scripts/capture-evidence.mjs compose \
//     docs/evidence/2026-10-04-device-identity-carry/journey.json
//
// The flow is two devices, each its own browser context with its own storage
// and vault, passing one file. It is the app's own path: the Export key makes
// an encrypted backup on the source device; on the device that is captured the
// Import key restores it. Both builds walk it the same way, at phone and
// desktop width. Measurements are read from the page and written beside the
// images, not typed from memory.
//
//   changed — the captured device had already connected, so its vault holds a
//             key of its own; the backup carries another. Principal and bell
//             after the restore.
//   keyless — the backup was made before any key existed; the captured device
//             restores it. Bell after the restore.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asBearer,
  configureScenarios,
  hostCall,
  mintInit,
} from "./lib/device-identity-scenarios.mjs";
import { passTheDoor } from "./lib/front-door.mjs";
import { PIN, sealLocalOnly } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const side = process.argv[2];
if (side !== "before" && side !== "after") {
  console.error("usage: capture-device-identity-notices.mjs <before|after>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.EVIDENCE_DIST ?? path.resolve(here, "..", "dist");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
// The directory `capture-evidence.mjs compose` reads for this journey file.
const OUT = path.join(os.tmpdir(), "opensesame-evidence", "journey", side);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "device-identity-"));

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: path.join(scratch, "log"),
});
fs.mkdirSync(path.join(scratch, "log"), { recursive: true });
const { check, setStep, launch, newPage, log } = harness;
configureScenarios({ ORIGIN, BASE, DIST, check, setStep, newPage });

const WIDTHS = [
  { name: "390", size: { width: 390, height: 844 }, phone: true },
  { name: "1280", size: { width: 1280, height: 900 }, phone: false },
];
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
};

const measurements = {};

async function device(browser, width) {
  const { page, context } = await newPage(browser, {
    device: width.phone ? PHONE : {},
  });
  await page.setViewportSize(width.size);
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await sealLocalOnly(page);
  return { page, context };
}

async function connect(page) {
  const res = await hostCall(page, "/v1/principals/provisional", mintInit);
  return { principalId: res.body.principalId, token: res.body.accessToken };
}

/** The Export key on a desktop-sized source device: one backup file. */
async function backupFrom(browser, name, { connectFirst }) {
  const source = await device(browser, WIDTHS[1]);
  const principal = connectFirst ? await connect(source.page) : null;
  await source.page
    .getByRole("button", { name: "Export items" })
    .locator("visible=true")
    .first()
    .click();
  const sheet = source.page.getByRole("dialog", {
    name: "Export encrypted vault",
  });
  await sheet.waitFor({ timeout: 15000 });
  const [download] = await Promise.all([
    source.page.waitForEvent("download"),
    sheet.getByRole("button", { name: "Save backup" }).click(),
  ]);
  const file = path.join(scratch, `${name}.json`);
  await download.saveAs(file);
  await source.context.close();
  return { file, principal };
}

/**
 * The Import key, then the restore card with the backup's PIN. With
 * `shot`, the card as drawn (before the choice is made) is captured and its
 * choice measured: how many there are, whether it is checked, its size.
 */
async function restore(page, file, shot) {
  await page.getByLabel("Choose a file to import").first().setInputFiles(file);
  const sheet = page.getByRole("dialog", { name: "Import items" });
  await sheet.waitFor({ timeout: 15000 });
  await sheet.getByLabel("PIN", { exact: true }).fill(PIN);
  // The card offers the backup's device identity to a vault that has done
  // nothing yet; the person takes it. The base build has no such choice.
  const choice = sheet.getByRole("checkbox", {
    name: "Also take its device identity",
  });
  let card = null;
  if (shot) {
    await page.waitForTimeout(500);
    card = await page.evaluate(() => {
      const dialog = document.querySelector(
        '[role="dialog"][aria-label="Import items"]',
      );
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      };
      const label = [...dialog.querySelectorAll("label.check")].find((el) =>
        /device identity/.test(el.textContent ?? ""),
      );
      return {
        sheet: box(dialog),
        choices: label ? 1 : 0,
        choice: label ? box(label) : null,
        checked: label?.querySelector("input")?.checked ?? null,
      };
    });
    await page.screenshot({ path: path.join(OUT, `${shot}.png`) });
    console.log(`  ${side}/${shot}: ${JSON.stringify(card)}`);
  }
  if ((await choice.count()) > 0) await choice.check();
  await sheet.getByRole("button", { name: "Restore items" }).click();
  await sheet
    .getByText("Restored", { exact: true })
    .waitFor({ timeout: 30000 });
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
  return card;
}

/**
 * The bell as drawn, opened, with what it says read from the page. A phone
 * draws no statusline: its bell is the Notifications row of the More sheet.
 */
async function bell(page, shot, phone) {
  let label;
  if (phone) {
    await page
      .getByRole("button", { name: /^More — / })
      .first()
      .click();
    const more = page.getByRole("dialog", { name: "More" });
    const row = more.getByRole("button", { name: /^Notifications/ });
    await row.waitFor({ timeout: 15000 });
    label = (await row.innerText()).replace(/\s+/g, " ").trim();
    await row.click();
  } else {
    const button = page
      .getByRole("button", { name: /^Notifications — / })
      .locator("visible=true")
      .first();
    await button.waitFor({ timeout: 15000 });
    label = await button.getAttribute("aria-label");
    await button.click();
  }
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  await sheet.waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const read = await page.evaluate(() => {
    const dialog = document.querySelector(
      '[role="dialog"][aria-label="Notifications"]',
    );
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    };
    const cards = [...dialog.querySelectorAll(".notice-card")];
    return {
      sheet: box(dialog),
      cards: cards.map((card) => ({
        title: card.querySelector("h3")?.textContent?.trim() ?? "",
        ...box(card),
      })),
      empty: /Nothing waiting/.test(dialog.innerText),
    };
  });
  await page.screenshot({ path: path.join(OUT, `${shot}.png`) });
  console.log(`  ${side}/${shot}: ${label} ${JSON.stringify(read)}`);
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
  return { label, ...read };
}

const browser = await launch();
const withKey = await backupFrom(browser, "with-key", { connectFirst: true });
const keyless = await backupFrom(browser, "keyless", { connectFirst: false });
for (const width of WIDTHS) {
  // changed: the captured vault minted a key of its own first.
  setStep(`${width.name}-changed`);
  const target = await device(browser, width);
  const own = await connect(target.page);
  const card = await restore(target.page, withKey.file, `${width.name}-card`);
  const after = await connect(target.page);
  const stale = await hostCall(
    target.page,
    "/v1/principals/me",
    asBearer(own.token),
  );
  const changed = await bell(target.page, `${width.name}-changed`, width.phone);
  measurements[`${width.name}-card`] = card;
  measurements[`${width.name}-changed`] = {
    ...changed,
    principalMatchesBackup: after.principalId === withKey.principal.principalId,
    ownBearerAfterRestore: stale.status,
  };
  await target.context.close();

  // keyless: a backup made before any key existed.
  setStep(`${width.name}-keyless`);
  const bare = await device(browser, width);
  await restore(bare.page, keyless.file);
  const minted = await connect(bare.page);
  const kept = await connect(bare.page);
  const note = await bell(bare.page, `${width.name}-keyless`, width.phone);
  measurements[`${width.name}-keyless`] = {
    ...note,
    sessionsShareOnePrincipal: minted.principalId === kept.principalId,
  };
  await bare.context.close();
}
await browser.close();
fs.writeFileSync(
  path.join(OUT, "measurements.json"),
  `${JSON.stringify(measurements, null, 2)}\n`,
);
fs.rmSync(scratch, { recursive: true, force: true });
const hard = log.filter((entry) =>
  ["PAGE-ERROR", "console-error", "HTTP-ERROR", "LOOPBACK-REQUEST"].includes(
    entry.kind,
  ),
);
for (const entry of hard)
  console.log(`${entry.kind} ${entry.detail.slice(0, 200)}`);
console.log(`captured ${side} into ${OUT}`);
