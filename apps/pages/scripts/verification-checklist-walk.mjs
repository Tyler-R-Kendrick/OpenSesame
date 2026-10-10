#!/usr/bin/env node
/**
 * Playwright evidence for the 2026-10 verification checklist.
 *
 * Builds Pages at VITE_BASE=/OpenSesame/ (security-profile.mjs, then vite,
 * the same shape as build-profile.mjs) and walks the checklist UI on
 * minimal-local, default (stock build; no fixture), custom (stock build;
 * the capabilities ceremony), and full (`capability-profiles/full.json`).
 * Screenshots land in
 * /opt/cursor/artifacts/verification-2026-10/<profile>/<step>.png.
 *
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     node apps/pages/scripts/verification-checklist-walk.mjs
 *   VERIFY_SKIP_BUILD=1 node apps/pages/scripts/verification-checklist-walk.mjs --only default
 */

import fs from "node:fs";
import path from "node:path";
import { findChromium } from "./duress/find-chromium.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  captureCommand,
  captureGuestShare,
  captureMissingControl,
  captureReset,
  captureSessionRoots,
  captureSettings,
  captureStatusline,
  captureSupport,
  createSecret,
  openShare,
  seedChecklistItems,
  trashChecklistItems,
} from "./lib/verification-checklist-app.mjs";
import {
  appPaths,
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import {
  applySetupChoice,
  captureChoices,
  enterVault,
  openDoor,
} from "./lib/verification-checklist-setup.mjs";
import {
  ARTIFACT_ROOT,
  createShot,
  emptyRecord,
  mark,
  profileDir,
} from "./lib/verification-checklist-shot.mjs";

function selectedNames(argv) {
  const at = argv.indexOf("--only");
  if (at === -1) return undefined;
  const raw = argv[at + 1];
  if (!raw) throw new Error("--only needs a comma-separated profile list");
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function prepareChromium() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[checklist] no Chromium binary");
    for (const probed of discovery.probed) console.error(`  ${probed}`);
    process.exit(2);
  }
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  console.error(
    `[checklist] chromium ${discovery.path} (${discovery.source}) ${discovery.version ?? ""}`,
  );
}

function buildsNeeded(walks) {
  const byKey = new Map();
  for (const walk of walks) {
    if (!byKey.has(walk.buildKey)) byKey.set(walk.buildKey, walk);
  }
  return [...byKey.values()];
}

async function walkInstalled(page, shot, record, choice) {
  await openDoor(page, shot, record);
  await captureChoices(page, shot, record);
  const where = await applySetupChoice(page, shot, record, choice);
  const entry = await enterVault(page, where);
  record.entry = entry;
  await captureSessionRoots(page, shot, record);
  const created = await createSecret(page, shot, record, "secret-editor");
  if (!created) return;
  await shot("vault-tree");
  const guides = await page.locator(".vtree__kids").count();
  mark(record, "U4-vault-tree", guides > 0, `guide boxes: ${guides}`);
  await openShare(page, shot, record, "share-menu", "S5-share");
  await seedChecklistItems(page, record);
  await trashChecklistItems(page);
  await captureSettings(page, shot, record);
  await captureCommand(page, shot, record);
  await captureStatusline(page, shot, record);
  await captureSupport(page, shot, record);
  await captureMissingControl(page, shot, record);
  await captureReset(page, shot, record);
}

async function walkProfile(harness, browser, walk) {
  const record = emptyRecord(walk);
  const dir = profileDir(walk.name);
  const opened = await harness.newPage(browser);
  opened.page.on("pageerror", (error) => {
    record.errors.push(`pageerror: ${error.message}`);
  });
  const shot = createShot(opened.page, dir, record);
  try {
    await walkInstalled(opened.page, shot, record, walk.setupChoice);
  } catch (error) {
    record.errors.push(String(error?.stack || error).slice(0, 900));
    await shot("failure").catch(() => undefined);
  }
  await opened.context.close();

  const guest = await harness.newPage(browser);
  const guestShot = createShot(guest.page, dir, record);
  try {
    await captureGuestShare(guest.page, guestShot, record);
  } catch (error) {
    record.errors.push(
      `guest: ${String(error?.message || error).slice(0, 400)}`,
    );
    await guestShot("guest-failure").catch(() => undefined);
  }
  await guest.context.close();
  return record;
}

function summarize(record) {
  const failed = record.checks.filter((check) => !check.ok);
  const flag = record.errors.length > 0 || failed.length > 0 ? "PARTIAL" : "OK";
  console.error(
    `[checklist] ${record.profile} ${flag} shots=${record.shots.length} failed-checks=${failed.length} errors=${record.errors.length}`,
  );
  for (const check of failed) {
    console.error(`  ${check.id}: ${check.detail}`);
  }
  for (const error of record.errors) console.error(`  ${error.split("\n")[0]}`);
}

async function main() {
  const names = selectedNames(process.argv.slice(2));
  const { appRoot, scriptsDir, profilesDir } = appPaths();
  const walks = resolveWalks(profilesDir, names);
  prepareChromium();
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const dists = new Map();
  for (const walk of buildsNeeded(walks)) {
    const outDir = path.join(
      appRoot,
      "dist-profiles",
      `verification-${walk.buildKey}`,
    );
    buildDist({
      appRoot,
      scriptsDir,
      outDir,
      capabilityProfile: walk.capabilityProfile,
    });
    dists.set(walk.buildKey, outDir);
  }
  const results = [];
  for (const walk of walks) {
    const dist = dists.get(walk.buildKey);
    const harness = createHarness({
      dist,
      origin: process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io",
      base: "/OpenSesame/",
      out: profileDir(walk.name),
    });
    const browser = await harness.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const record = await walkProfile(harness, browser, walk);
      results.push(record);
      summarize(record);
    } finally {
      await browser.close();
    }
  }
  const file = path.join(ARTIFACT_ROOT, "results.json");
  fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.error(`[checklist] wrote ${file}`);
  const broken = results.some(
    (record) =>
      record.errors.length > 0 || !record.shots.includes("front-door"),
  );
  process.exit(broken ? 1 : 0);
}

await main();
