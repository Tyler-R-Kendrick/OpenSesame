#!/usr/bin/env node
/**
 * Evidence driver, kept here as review material. Its imports expect it to sit
 * in `work/evidence/live-changed-key/pages/web/` of a checkout with the after
 * commit's `apps/pages/scripts`. It photographs the joiner's join form after its first
 * ask is refused because the owner's key changed (ADR 0163: a failure is a
 * StatusMark on the row that failed and a notice in the tray). Two browser
 * contexts, the repository's own live-join walk helpers, the same steps on
 * both builds:
 *
 *   node capture-changed-key.mjs <before|after|current> <journey.json>
 *
 * The owner (desktop) seals a PIN vault, keeps one login, switches Live
 * sessions on, starts an invite session and copies its peer trust signal.
 * The joiner (one screen of the journey: its width and height, a phone
 * context unless the screen says desktop) opens the link on a new device. A
 * different peer is already remembered there, as after an earlier session
 * with another owner. The joiner gives the code, a name and a PIN for their
 * own vault, pastes the signal and asks. The ask creates the joiner's vault,
 * which mounts the form again; the remembered-key check refuses the key. The
 * shot is taken once the tray has the notice, and the driver prints what the
 * form shows: the row's mark and whether Ask to join is enabled.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureShotsDirectory } from "../../../../../apps/pages/scripts/lib/evidence-paths.mjs";
import {
  WATCH_RTC,
  copyFrom,
  openLive,
  ownerEnters,
  startSession,
  unfoldPeerTrust,
} from "../../../../../apps/pages/scripts/lib/live-join-walk.mjs";
import { phoneContext } from "../../../../../apps/pages/scripts/lib/mobile-contract.mjs";
import { PIN } from "../../../../../apps/pages/scripts/lib/pages-journey.mjs";
import { createHarness } from "../../../../../apps/pages/scripts/lib/static-origin-harness.mjs";

const [label, journeyPath] = process.argv.slice(2);
const journey = JSON.parse(fs.readFileSync(journeyPath, "utf8"));
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = process.env.EVIDENCE_DIST ?? path.join(ROOT, "apps/pages/dist");
const into =
  label === "current"
    ? path.join(path.dirname(journeyPath), "current")
    : path.join(captureShotsDirectory(journeyPath), label);
fs.rmSync(into, { recursive: true, force: true });
fs.mkdirSync(into, { recursive: true });
const OUT = fs.mkdtempSync(
  path.join(captureShotsDirectory(journeyPath), "walk-"),
);
const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const SECRET = "correct-horse-battery-staple-2026";
const CHANGED = "This peer's key changed";
const WRONG_FINGERPRINT = "ab".repeat(32);

async function device(browser, options = {}) {
  const made = await harness.newPage(browser, {
    origin: ORIGIN,
    dist: DIST,
    passthrough: [],
    ...options,
  });
  await made.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await made.context.addInitScript(WATCH_RTC);
  return made;
}

/** A peer this device remembers from before, with another key. */
function rememberAnotherPeer(page) {
  return page.evaluate(async (print) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("opensesame-peer-trust", 1);
      req.onupgradeneeded = () => {
        for (const store of ["trust", "ark"])
          if (!req.result.objectStoreNames.contains(store))
            req.result.createObjectStore(store, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("trust", "readwrite");
      tx.objectStore("trust").put({
        id: "peers",
        peers: [{ fingerprint: print, epoch: 1 }],
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, WRONG_FINGERPRINT);
}

const box = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`;
  });
const marks = (scope) =>
  scope
    .locator("[role=img][aria-label]")
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => n.getClientRects().length)
        .map((n) => n.getAttribute("aria-label")),
    );

/** The owner's invite session and the peer trust signal it hands out. */
async function hosted(browser) {
  const owner = await device(browser, {
    device: { viewport: { width: 1280, height: 900 } },
  });
  await ownerEnters(owner.page, { origin: ORIGIN, base: BASE, secret: SECRET });
  await openLive(owner.page);
  const started = await startSession(owner.page);
  await unfoldPeerTrust(started.panel);
  const copy = started.panel.getByRole("button", {
    name: "Copy peer trust signal",
  });
  await copy.waitFor({ timeout: 20_000 });
  const signal = await copyFrom(owner.page, copy);
  return { owner, ...started, signal };
}

/** The joiner's first ask, from a new device that remembers another peer. */
async function asks(seat, { link, code, signal }) {
  await seat.goto(link, { waitUntil: "networkidle" });
  await seat
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  const apply = seat.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await seat.getByLabel("Your name").waitFor({ timeout: 20_000 });
  await rememberAnotherPeer(seat);
  if (code) await seat.getByLabel("Code").fill(code.toLowerCase());
  await seat.getByLabel("Your name").fill("Casey");
  await seat.getByLabel("Your vault PIN", { exact: true }).fill(PIN);
  await seat.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await seat
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  const advanced = seat.locator("details.live-advanced").filter({
    has: seat.getByLabel("Peer trust signal", { exact: true }),
  });
  if ((await advanced.getAttribute("open")) === null)
    await advanced.locator("summary").click();
  await seat.getByLabel("Peer trust signal", { exact: true }).fill(signal);
  await seat.getByRole("button", { name: "Ask to join" }).click();
  // The refusal reaches the tray: the bell, or the phone's More menu, says so.
  await seat
    .getByRole("button", { name: /^Notifications — [1-9]\d* pending/ })
    .or(seat.locator(".topbar__more.is-attn"))
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await seat.waitForTimeout(1500);
}

const browser = await harness.launch();
try {
  for (const screen of journey.screens) {
    console.log(`screen ${screen.name} ${screen.width}x${screen.height}`);
    const { owner, link, code, signal } = await hosted(browser);
    const joiner = await device(browser, {
      device: screen.desktop
        ? { viewport: { width: screen.width, height: screen.height } }
        : phoneContext({ width: screen.width, height: screen.height }),
    });
    const seat = joiner.page;
    await asks(seat, { link, code, signal });
    const form = seat
      .locator("form")
      .filter({ has: seat.getByLabel("Your name") });
    const mark = form.getByRole("img", { name: CHANGED });
    const ask = form.getByRole("button", { name: /^Ask to join/ });
    await ask.scrollIntoViewIfNeeded();
    const shown = await mark.isVisible().catch(() => false);
    console.log(`  row mark "${CHANGED}": ${shown ? "present" : "absent"}`);
    if (shown) console.log(`  row mark box: ${await box(mark)}`);
    console.log(
      `  Ask to join: ${(await ask.isDisabled()) ? "disabled" : "enabled"} ${await box(ask)}`,
    );
    console.log(`  Ask to join name: ${await ask.getAttribute("aria-label")}`);
    console.log(`  PIN fields left: ${await seat.getByLabel("Your vault PIN", { exact: true }).count()}`);
    console.log(`  form marks: ${(await marks(form)).join(" | ") || "none"}`);
    console.log(`  joiner address: ${new URL(seat.url()).pathname}`);
    await seat.screenshot({
      path: path.join(into, `${screen.name}-changed-key.png`),
    });
    console.log(`  shot ${path.basename(into)}/${screen.name}-changed-key`);
    await joiner.context.close();
    await owner.context.close();
  }
} finally {
  await browser.close();
}
if (harness.failures.length)
  console.log(`harness failures: ${harness.failures.join("; ")}`);
console.log(`captures: ${into}`);
