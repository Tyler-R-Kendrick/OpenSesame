/**
 * Round 8 install-profile galleries for P8-1 and P8-2.
 *
 * Each profile dist is `security-profile.mjs` then `vite build` with
 * `VITE_BASE=/OpenSesame/` (`buildDist`). `default` and `custom` share the
 * stock build; `custom` has no capability-profiles file.
 *
 *   P8-1 before  40681647c  parent of merge #1457
 *   P8-1 after   51f27bc95  portable drop on main
 *   P8-2 before  51f27bc95
 *   P8-2 after   this branch's tip
 *
 * P8-1 walks the guest drop the way `verify-portable-drop.mjs` does: share
 * form, then the Drop ready region. P8-2 starts a live session, copies the
 * peer-trust signal, and stops when the host's admit control is on screen
 * (SAS compare, or Let in on the earlier build). It does not finish WebRTC.
 *
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     node apps/pages/scripts/capture-round8-profile-evidence.mjs
 *
 * `VERIFY_SKIP_BUILD=1` reuses a dist that already has index.html.
 * `ROUND8_ONLY=p8-1` or `p8-2` captures one gallery.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";
import { doorGuest } from "./lib/front-door.mjs";
import {
  copyFrom,
  joinerAsks,
  ownerEnters,
  startSession,
} from "./lib/live-join-walk.mjs";
import { waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  WALK_NAMES,
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import { composeSheet } from "./lib/visual-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = "/OpenSesame/";
const P8_1_BEFORE = "40681647c9ea585c6ec5fb920e81e2c7a70b12da";
const P8_1_AFTER = "51f27bc95716afda76eeae4629a18abfd03115ba";
const WT_ROOT = "/tmp/p8-ev-wt";
const SHOT_ROOT = path.join(os.tmpdir(), "p8-round8-shots");
const SECRET = "correct-horse-battery-staple-2026";
const JOINER = "Ada Lovelace";
const PHONE = devices["iPhone 13"];

const VIEWS = Object.freeze([
  {
    id: "1280",
    width: 1280,
    height: 900,
    desktop: true,
    device: {
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  {
    id: "390",
    width: 390,
    height: 844,
    desktop: false,
    device: {
      userAgent: PHONE.userAgent,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    },
  },
]);

function log(message) {
  console.error(`[round8] ${new Date().toISOString()} ${message}`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tipSha() {
  return git(REPO, ["rev-parse", "HEAD"]);
}

function listNodeModules(root) {
  const out = execFileSync(
    "find",
    [root, "-name", "node_modules", "-prune", "-print"],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

function mirrorNodeModules(fromRoot, toRoot) {
  const marker = path.join(toRoot, "apps/pages/node_modules/vite/package.json");
  if (fs.existsSync(marker)) {
    log(`node_modules present in ${toRoot}`);
    return;
  }
  log(`mirror node_modules → ${toRoot}`);
  for (const abs of listNodeModules(fromRoot)) {
    const rel = path.relative(fromRoot, abs);
    if (rel.startsWith("..")) continue;
    const dest = path.join(toRoot, rel);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // Symlinks stay symlinks so workspace packages resolve inside this tree.
    execFileSync("cp", ["-a", `${abs}/.`, dest]);
  }
  const link = path.join(
    toRoot,
    "apps/pages/node_modules/@opensesame/app-core",
  );
  const target = fs.readlinkSync(link);
  if (path.isAbsolute(target)) {
    throw new Error(`workspace link must stay relative: ${link} → ${target}`);
  }
}

function ensureTree(sha) {
  if (sha === tipSha()) return REPO;
  const dir = path.join(WT_ROOT, sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, ".git"))) {
    const at = git(dir, ["rev-parse", "HEAD"]);
    if (at !== sha) throw new Error(`${dir} is ${at}, want ${sha}`);
  } else {
    fs.mkdirSync(WT_ROOT, { recursive: true });
    log(`worktree ${sha.slice(0, 12)}`);
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], {
      cwd: REPO,
      stdio: "inherit",
    });
  }
  mirrorNodeModules(REPO, dir);
  return dir;
}

function restoreSecurityProfile(tree) {
  execFileSync(
    "git",
    ["checkout", "--", "apps/pages/public/security-profile.json"],
    { cwd: tree, stdio: "inherit" },
  );
}

function buildsFor(tree) {
  const appRoot = path.join(tree, "apps/pages");
  const scriptsDir = path.join(appRoot, "scripts");
  const profilesDir = path.join(appRoot, "capability-profiles");
  const walks = resolveWalks(profilesDir);
  const dists = new Map();
  const seen = new Set();
  try {
    for (const walk of walks) {
      if (seen.has(walk.buildKey)) continue;
      seen.add(walk.buildKey);
      const outDir = path.join(
        appRoot,
        "dist-profiles",
        `round8-${walk.buildKey}`,
      );
      log(
        `build ${walk.buildKey} @ ${git(tree, ["rev-parse", "--short", "HEAD"])}`,
      );
      buildDist({
        appRoot,
        scriptsDir,
        outDir,
        capabilityProfile: walk.capabilityProfile,
      });
      if (!fs.existsSync(path.join(outDir, "index.html"))) {
        throw new Error(`build produced no index.html at ${outDir}`);
      }
      dists.set(walk.buildKey, outDir);
    }
  } finally {
    restoreSecurityProfile(tree);
  }
  return { walks, dists };
}

function requireChromium() {
  const binary = process.env.PLAYWRIGHT_CHROMIUM;
  if (!binary) throw new Error("PLAYWRIGHT_CHROMIUM is unset");
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    throw new Error(`PLAYWRIGHT_CHROMIUM is not executable: ${binary}`);
  }
  return binary;
}

function launchBrowser() {
  return chromium.launch({
    executablePath: requireChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

function harnessFor(dist) {
  return createHarness({
    dist,
    origin: ORIGIN,
    base: BASE,
    out: path.join(SHOT_ROOT, "harness"),
  });
}

async function openPage(harness, browser, device) {
  const opened = await harness.newPage(browser, { device });
  await opened.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  opened.page.setDefaultTimeout(25_000);
  opened.page.setDefaultNavigationTimeout(45_000);
  opened.page.on("pageerror", (error) => {
    log(`pageerror ${String(error.message || error).split("\n")[0]}`);
  });
  return opened;
}

async function go(page, route) {
  await page.evaluate(
    ([base, to]) => {
      history.pushState({}, "", base + to.replace(/^\//, ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [BASE, route],
  );
  await page.waitForTimeout(900);
}

async function createSecret(page, name, value) {
  await go(page, "/vault/new");
  const nameField = page.getByLabel("Name", { exact: true });
  await nameField.waitFor({ timeout: 20_000 });
  await nameField.fill(name);
  await page.getByLabel("Secret value", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name, exact: true })
    .waitFor({ timeout: 20_000 });
}

function textCounts(text) {
  const n = (needle) => text.split(needle).length - 1;
  return {
    any: n("Any browser with the link"),
    here: n("This browser"),
    warning: n("Only this browser can open this drop"),
  };
}

async function opensOn(scope) {
  const rows = scope.locator(".frow");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const label = (
      await row
        .locator(".frow__label")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (label !== "Opens on") continue;
    const value = row.locator(".frow__value").first();
    if ((await value.count()) === 0) return "";
    return (await value.innerText()).replace(/\s+/g, " ").trim();
  }
  return "";
}

async function measureRegion(scope) {
  const text = await scope.innerText();
  return { ...textCounts(text), opensOn: await opensOn(scope) };
}

async function shoot(page, locator, file) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await page.waitForTimeout(250);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
}

async function captureDrop(page, files) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);
  await createSecret(page, "Harbor note", "harbor-lantern-42");
  await page.getByRole("button", { name: "Share once" }).click();
  const share = page.getByRole("region", { name: "Share this item once" });
  await share.waitFor({ timeout: 15_000 });
  const shareMeasure = await measureRegion(share);
  await shoot(page, share, files.share);
  await page.getByRole("button", { name: "Seal and share" }).click();
  const ready = page.getByRole("region", { name: "Drop ready" });
  await ready.waitFor({ timeout: 30_000 });
  const readyMeasure = await measureRegion(ready);
  await shoot(page, ready, files.ready);
  return { share: shareMeasure, ready: readyMeasure };
}

async function labeledValue(scope, label) {
  const rows = scope.locator(".frow");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = (
      await row
        .locator(".frow__label")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (text !== label) continue;
    const value = row.locator(".frow__value").first();
    if ((await value.count()) === 0) return "";
    return (await value.innerText()).replace(/\s+/g, " ").trim();
  }
  return null;
}

async function capturePeer(browser, dist, device, files) {
  const harness = harnessFor(dist);
  const owner = await openPage(harness, browser, device);
  const measure = {
    fingerprint: null,
    shortAuth: null,
    unavailable: 0,
    qr: 0,
    copy: 0,
    match: 0,
    letIn: 0,
    rowSas: "",
    joinerSas: "",
    compareError: "",
  };
  try {
    await ownerEnters(owner.page, {
      origin: ORIGIN,
      base: BASE,
      secret: SECRET,
    });
    const started = await startSession(owner.page);
    const panel = started.panel;
    const copyKey = panel.getByRole("button", {
      name: "Copy peer trust signal",
    });
    const unavailable = panel.getByText(
      "Peer trust is not available on this device",
      { exact: true },
    );
    await copyKey.or(unavailable).first().waitFor({ timeout: 25_000 });
    measure.unavailable = await unavailable.count();
    measure.copy = await copyKey.count();
    measure.qr = await panel
      .getByRole("button", { name: "Show fingerprint QR" })
      .count();
    measure.fingerprint = await labeledValue(panel, "Fingerprint");
    measure.shortAuth = await labeledValue(
      panel,
      "Short authentication string",
    );
    await shoot(owner.page, panel, files.export);
    if (measure.copy === 0) {
      measure.compareError = "peer trust signal was not copied";
      await shoot(owner.page, panel, files.compare);
      return measure;
    }
    const signal = await copyFrom(owner.page, copyKey);
    const joiner = await openPage(harness, browser, device);
    try {
      const request = await joinerAsks(joiner.page, {
        link: started.link,
        code: started.code,
        name: JOINER,
        peerTrust: signal,
      });
      const joinerSas = joiner.page.locator(".live-sas").first();
      if ((await joinerSas.count()) > 0) {
        measure.joinerSas = (await joinerSas.innerText()).trim();
      }
      await panel.getByLabel("A request code", { exact: true }).fill(request);
      await panel.getByRole("button", { name: "Read the request" }).click();
      const match = panel.getByRole("button", {
        name: `Yes, they match for ${JOINER}`,
      });
      const letIn = panel.getByRole("button", { name: `Let ${JOINER} in` });
      await match.or(letIn).first().waitFor({ timeout: 20_000 });
      measure.match = await match.count();
      measure.letIn = await letIn.count();
      const guest = panel.locator(".vault-row", { hasText: JOINER }).first();
      const rowSas = guest.locator(".live-sas").first();
      if ((await rowSas.count()) > 0) {
        measure.rowSas = (await rowSas.innerText()).trim();
      }
      await shoot(owner.page, guest, files.compare);
    } finally {
      await joiner.context.close();
    }
  } catch (error) {
    measure.compareError = String(error?.message || error).split("\n")[0];
    log(`peer capture: ${measure.compareError}`);
    fs.mkdirSync(path.dirname(files.compare), { recursive: true });
    if (!fs.existsSync(files.export)) {
      await owner.page
        .screenshot({ path: files.export, fullPage: false })
        .catch(() => {});
    }
    if (!fs.existsSync(files.compare)) {
      await owner.page
        .screenshot({ path: files.compare, fullPage: false })
        .catch(() => {});
    }
    throw error;
  } finally {
    await owner.context.close();
  }
  return measure;
}

async function walkSides(browser, feature, sides, walkOne) {
  const out = {};
  for (const side of sides) {
    out[side.name] = {};
    for (const walk of side.built.walks) {
      const dist = side.built.dists.get(walk.buildKey);
      out[side.name][walk.name] = { note: walk.note, buildKey: walk.buildKey };
      for (const view of VIEWS) {
        const dir = path.join(SHOT_ROOT, feature, side.name);
        const stem = `${walk.name}-${view.id}`;
        log(`${feature} ${side.name} ${walk.name} ${view.id}`);
        const files = {
          share: path.join(dir, `${stem}-share.png`),
          ready: path.join(dir, `${stem}-ready.png`),
          export: path.join(dir, `${stem}-export.png`),
          compare: path.join(dir, `${stem}-compare.png`),
        };
        try {
          out[side.name][walk.name][view.id] = await walkOne({
            browser,
            dist,
            view,
            files,
          });
        } catch (error) {
          const message = String(error?.stack || error).slice(0, 1200);
          log(
            `FAIL ${feature} ${side.name} ${walk.name} ${view.id}: ${message}`,
          );
          throw error;
        }
      }
    }
  }
  return out;
}

function q(value) {
  if (value === null || value === undefined || value === "") return "absent";
  return `“${value}”`;
}

function dropCaption(profile, view, before, after, kind) {
  const left = before[kind];
  const right = after[kind];
  const place = kind === "share" ? "Share once, before seal" : "Drop ready";
  return [
    `${place} on ${profile} at ${view.width} × ${view.height}.`,
    `Before: Opens on is ${q(left.opensOn)} (${left.any} × Any browser with the link, ${left.here} × This browser, ${left.warning} × device-only warning).`,
    `After: Opens on is ${q(right.opensOn)} (${right.any} × Any browser with the link, ${right.here} × This browser, ${right.warning} × device-only warning).`,
  ].join(" ");
}

function dropNote(measure) {
  return `Opens on ${q(measure.opensOn)} · any ${measure.any} · this browser ${measure.here}`;
}

function peerExportCaption(profile, view, before, after) {
  return [
    `Host peer-trust export on ${profile} at ${view.width} × ${view.height}, after Start the live session.`,
    `Before: Fingerprint ${q(before.fingerprint)}, Short authentication string ${q(before.shortAuth)}, copy control ${before.copy}, Show fingerprint QR ${before.qr}, unavailable ${before.unavailable}.`,
    `After: Fingerprint ${q(after.fingerprint)}, Short authentication string ${q(after.shortAuth)}, copy control ${after.copy}, Show fingerprint QR ${after.qr}, unavailable ${after.unavailable}.`,
  ].join(" ");
}

function peerCompareCaption(profile, view, before, after) {
  const same =
    after.rowSas !== "" && after.rowSas === after.joinerSas
      ? "The host row and the joiner show the same SAS."
      : "The host row and the joiner do not show one shared SAS.";
  const trouble = [before.compareError, after.compareError]
    .filter(Boolean)
    .join(" ");
  return [
    `Host admit control for ${JOINER} on ${profile} at ${view.width} × ${view.height}, after the joiner asks with the copied signal and the host reads the request.`,
    `Before: Yes, they match ${before.match}, Let ${JOINER} in ${before.letIn}, guest-row SAS ${q(before.rowSas)}, joiner SAS ${q(before.joinerSas)}.`,
    `After: Yes, they match ${after.match}, Let ${JOINER} in ${after.letIn}, guest-row SAS ${q(after.rowSas)}, joiner SAS ${q(after.joinerSas)}. ${same}`,
    trouble ? `Capture note: ${trouble}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function peerExportNote(measure) {
  const shown = measure.fingerprint ?? measure.shortAuth;
  const label =
    measure.fingerprint !== null
      ? "Fingerprint"
      : "Short authentication string";
  return `${label} ${q(shown)} · QR ${measure.qr}`;
}

function peerCompareNote(measure) {
  if (measure.match > 0)
    return `Yes, they match ${measure.match} · SAS ${q(measure.rowSas)}`;
  if (measure.letIn > 0) return `Let ${JOINER} in ${measure.letIn}`;
  return measure.compareError || "admit control absent";
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function composeGallery(browser, dir, sheets, beforeDir, afterDir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const sheet of sheets) {
    const spec = {
      ...sheet,
      title: htmlEscape(sheet.title),
      caption: htmlEscape(sheet.caption),
      rows: sheet.rows.map((row) => ({
        ...row,
        heading: htmlEscape(row.heading),
        before: htmlEscape(row.before),
        after: htmlEscape(row.after),
      })),
    };
    await composeSheet(
      browser,
      spec,
      { before: beforeDir, after: afterDir },
      dir,
    );
    log(`sheet ${path.join(dir, `${sheet.shot}.png`)}`);
  }
}

function writeReadme(dir, title, intro, sheets) {
  const parts = [`# ${title}`, "", intro.trim(), ""];
  for (const sheet of sheets) {
    parts.push(
      `## ${sheet.title}`,
      "",
      sheet.caption,
      "",
      `![${sheet.title}](${sheet.shot}.png)`,
      "",
    );
  }
  fs.writeFileSync(path.join(dir, "README.md"), `${parts.join("\n")}\n`);
}

function writeJourney(dir, journey) {
  fs.writeFileSync(
    path.join(dir, "journey.json"),
    `${JSON.stringify(journey, null, 2)}\n`,
  );
}

function dropSheets(walks, captured) {
  const sheets = [];
  const screens = [];
  for (const walk of walks) {
    for (const view of VIEWS) {
      const before = captured.before[walk.name][view.id];
      const after = captured.after[walk.name][view.id];
      const stem = `${walk.name}-${view.id}`;
      const shareCaption = dropCaption(walk.name, view, before, after, "share");
      const readyCaption = dropCaption(walk.name, view, before, after, "ready");
      sheets.push({
        shot: stem,
        width: view.width,
        title: `${walk.name} — share and drop ready, ${view.width} × ${view.height}`,
        caption: `${shareCaption} ${readyCaption}`,
        rows: [
          {
            shot: `${stem}-share`,
            heading: "Share once",
            before: dropNote(before.share),
            after: dropNote(after.share),
          },
          {
            shot: `${stem}-ready`,
            heading: "Drop ready",
            before: dropNote(before.ready),
            after: dropNote(after.ready),
          },
        ],
      });
      screens.push({
        width: view.width,
        height: view.height,
        desktop: view.desktop,
        profile: walk.name,
        buildKey: walk.buildKey,
        steps: [
          { guest: null },
          { visit: "/vault/new" },
          { press: "Share once" },
          { shot: `${stem}-share` },
          { press: "Seal and share" },
          { shot: `${stem}-ready` },
        ],
      });
    }
  }
  return { sheets, screens };
}

function peerSheets(walks, captured) {
  const sheets = [];
  const screens = [];
  for (const walk of walks) {
    for (const view of VIEWS) {
      const before = captured.before[walk.name][view.id];
      const after = captured.after[walk.name][view.id];
      const stem = `${walk.name}-${view.id}`;
      sheets.push({
        shot: stem,
        width: view.width,
        title: `${walk.name} — peer trust, ${view.width} × ${view.height}`,
        caption: `${peerExportCaption(walk.name, view, before, after)} ${peerCompareCaption(walk.name, view, before, after)}`,
        rows: [
          {
            shot: `${stem}-export`,
            heading: "Host export",
            before: peerExportNote(before),
            after: peerExportNote(after),
          },
          {
            shot: `${stem}-compare`,
            heading: "Admit",
            before: peerCompareNote(before),
            after: peerCompareNote(after),
          },
        ],
      });
      screens.push({
        width: view.width,
        height: view.height,
        desktop: view.desktop,
        profile: walk.name,
        buildKey: walk.buildKey,
        steps: [
          { guest: null },
          { tab: "Settings" },
          { press: "Live sessions" },
          { press: "Start the live session" },
          { shot: `${stem}-export` },
          { press: "Ask to join" },
          { press: "Read the request" },
          { shot: `${stem}-compare` },
        ],
      });
    }
  }
  return { sheets, screens };
}

function galleryIntro(kind, beforeSha, afterSha, walks) {
  const lines = walks.map((walk) => {
    const how = walk.capabilityProfile
      ? `capability profile ${path.basename(walk.capabilityProfile)}`
      : walk.note;
    return `- \`${walk.name}\` (${walk.setupChoice}): ${how}`;
  });
  const subject =
    kind === "p8-1"
      ? "Guest flow, same steps as `verify-portable-drop.mjs`: Skip on the front door, a new secret, Share once, then Seal and share. The pair is the Opens on row on the share form and again inside Drop ready."
      : "Guest flow into a live session, the same host steps as `verify-peer-trust-two-context.mjs` through the admit control. The joiner pastes the copied peer-trust signal and asks. The host reads the request. The sheet stops there, with Yes, they match or Let in still on screen. WebRTC connect is not part of this gallery.";
  return [
    `Before \`${beforeSha}\`. After \`${afterSha}\`.`,
    "Each profile is a real Pages dist: `security-profile.mjs`, then `vite build` with `VITE_BASE=/OpenSesame/`. Desktop is 1280 × 900 with a mouse. Phone is 390 × 844, touch, coarse pointer.",
    subject,
    "Profiles:",
    ...lines,
  ].join("\n\n");
}

async function emitGallery({
  browser,
  feature,
  title,
  folder,
  beforeSha,
  afterSha,
  walks,
  captured,
  sheetsOf,
}) {
  const dir = path.join(REPO, "docs/evidence", folder);
  const { sheets, screens } = sheetsOf(walks, captured);
  await composeGallery(
    browser,
    dir,
    sheets,
    path.join(SHOT_ROOT, feature, "before"),
    path.join(SHOT_ROOT, feature, "after"),
  );
  const intro = galleryIntro(feature, beforeSha, afterSha, walks);
  writeReadme(dir, title, intro, sheets);
  writeJourney(dir, {
    out: ".",
    driver: "apps/pages/scripts/capture-round8-profile-evidence.mjs",
    before: beforeSha,
    after: afterSha,
    profiles: WALK_NAMES,
    screens,
    sheets: sheets.map((sheet) => ({
      shot: sheet.shot,
      width: sheet.width,
      title: sheet.title,
      caption: sheet.caption,
      before: sheet.rows.map((row) => row.before).join(" · "),
      after: sheet.rows.map((row) => row.after).join(" · "),
    })),
    measurements: captured,
  });
}

function selectedFeatures() {
  const only = process.env.ROUND8_ONLY;
  if (!only) return ["p8-1", "p8-2"];
  if (only !== "p8-1" && only !== "p8-2") {
    throw new Error("ROUND8_ONLY must be p8-1 or p8-2");
  }
  return [only];
}

async function main() {
  requireChromium();
  if (WALK_NAMES.length !== 4) {
    throw new Error(`expected four walk names, got ${WALK_NAMES.join(",")}`);
  }
  const afterP2 = tipSha();
  const features = selectedFeatures();
  const shas = new Set();
  if (features.includes("p8-1")) {
    shas.add(P8_1_BEFORE);
    shas.add(P8_1_AFTER);
  }
  if (features.includes("p8-2")) {
    shas.add(P8_1_AFTER);
    shas.add(afterP2);
  }
  const builtBySha = new Map();
  for (const sha of shas) {
    const tree = ensureTree(sha);
    builtBySha.set(sha, buildsFor(tree));
  }
  const browser = await launchBrowser();
  try {
    if (features.includes("p8-1")) {
      const before = { name: "before", built: builtBySha.get(P8_1_BEFORE) };
      const after = { name: "after", built: builtBySha.get(P8_1_AFTER) };
      const captured = await walkSides(
        browser,
        "p8-1",
        [before, after],
        async ({ browser: liveBrowser, dist, view, files }) => {
          const opened = await openPage(
            harnessFor(dist),
            liveBrowser,
            view.device,
          );
          try {
            return await captureDrop(opened.page, files);
          } finally {
            await opened.context.close();
          }
        },
      );
      await emitGallery({
        browser,
        feature: "p8-1",
        title: "Portable drop on four install profiles",
        folder: "2026-10-17-p8-1-portable-drop-profiles",
        beforeSha: P8_1_BEFORE,
        afterSha: P8_1_AFTER,
        walks: before.built.walks,
        captured,
        sheetsOf: dropSheets,
      });
    }
    if (features.includes("p8-2")) {
      const before = { name: "before", built: builtBySha.get(P8_1_AFTER) };
      const after = { name: "after", built: builtBySha.get(afterP2) };
      const captured = await walkSides(
        browser,
        "p8-2",
        [before, after],
        ({ browser: liveBrowser, dist, view, files }) =>
          capturePeer(liveBrowser, dist, view.device, files),
      );
      await emitGallery({
        browser,
        feature: "p8-2",
        title: "Peer trust on four install profiles",
        folder: "2026-10-17-p8-2-peer-trust-profiles",
        beforeSha: P8_1_AFTER,
        afterSha: afterP2,
        walks: before.built.walks,
        captured,
        sheetsOf: peerSheets,
      });
    }
  } finally {
    await browser.close();
  }
  execFileSync("node", ["scripts/quality/docs-index.mjs"], {
    cwd: REPO,
    stdio: "inherit",
  });
  log("done");
}

await main();
