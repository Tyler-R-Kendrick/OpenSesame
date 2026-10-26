#!/usr/bin/env node
/**
 * Peer-trust peering on the static dist, two browser contexts (journeys-2).
 *
 * One run: the two owners' `.live-sas` values differ; a copied signal joins;
 * that signal on the other session's link is refused; a remembered wrong
 * fingerprint blocks Ask; two joiners with one display name are marked.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { answerAddresses } from "./lib/live-join-addresses.mjs";
import {
  WATCH_RTC,
  admitControl,
  copyFrom,
  joinerAsks,
  joinerConnects,
  openLive,
  ownerAdmitsByHand,
  ownerEnters,
  peerStates,
  setRoutes,
  startSession,
} from "./lib/live-join-walk.mjs";
import { joinedMarks, opensSharedItems } from "./lib/live-joined.mjs";
import { allowLoopbackDevelopment } from "./lib/local-network-permission.mjs";
import { PIN } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const DIST = path.resolve(here, "../dist");
const OUT = path.resolve(ROOT, "artifacts/peer-trust-two-context");
const SECRET = "correct-horse-battery-staple-2026";
const SAS = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;
const SIGNAL_KIND = "opensesame.peer-trust-signal.v1";
const CHANGED = "This peer's key changed";
const WRONG_FINGERPRINT = "ab".repeat(32);
const VERIFIED_NAME = "Ada Lovelace";
const CLASH_NAME = "Sam";

fs.mkdirSync(OUT, { recursive: true });

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { failures, check, setStep } = harness;

function launch() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
    args: ["--allow-loopback-in-peer-connection"],
  });
}

async function device(browser) {
  const made = await harness.newPage(browser, {
    origin: ORIGIN,
    dist: DIST,
    passthrough: [],
  });
  await allowLoopbackDevelopment(made.page, ORIGIN, [
    "clipboardReadWrite",
    "clipboardSanitizedWrite",
  ]);
  await made.context.addInitScript(WATCH_RTC);
  return made;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function seedWrongPeer(page, fingerprint) {
  return page.evaluate(async (print) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("opensesame-peer-trust", 1);
      req.onupgradeneeded = () => {
        const base = req.result;
        if (!base.objectStoreNames.contains("trust")) {
          base.createObjectStore("trust", { keyPath: "id" });
        }
        if (!base.objectStoreNames.contains("ark")) {
          base.createObjectStore("ark", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("trust", "readwrite");
      tx.objectStore("trust").put({
        id: "peers",
        peers: [{ fingerprint: print, epoch: 1 }],
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
    });
    db.close();
    return print;
  }, fingerprint);
}

async function beginOwner(browser) {
  const owner = await device(browser);
  await ownerEnters(owner.page, {
    origin: ORIGIN,
    base: BASE,
    secret: SECRET,
  });
  await openLive(owner.page);
  await setRoutes(owner.page, { addresses: ["127.0.0.1"] });
  const started = await startSession(owner.page);
  await started.panel
    .locator("summary")
    .filter({ hasText: /^Peer trust signal$/ })
    .click();
  const copyKey = started.panel.getByRole("button", {
    name: "Copy peer trust signal",
  });
  await copyKey.waitFor({ timeout: 20_000 });
  const sasLoc = started.panel.locator(".live-sas");
  await sasLoc.waitFor({ timeout: 20_000 });
  const sas = (await sasLoc.innerText()).trim();
  const signal = await copyFrom(owner.page, copyKey);
  return { ...owner, ...started, sas, signal };
}

async function readRequest(panel, request) {
  await panel.getByLabel("Paste a join request", { exact: true }).fill(request);
  await panel.getByRole("button", { name: "Read the request" }).click();
}

async function verifiedJoin(browser, session) {
  setStep("verified-join");
  console.log("verified-join");
  const joiner = await device(browser);
  const request = await joinerAsks(joiner.page, {
    link: session.link,
    code: session.code,
    name: VERIFIED_NAME,
    peerTrust: session.signal,
  });
  check(
    (await joiner.page.getByRole("img", { name: "Unverified" }).count()) === 0,
    "verified join is not marked unverified",
  );
  // ownerAdmitsByHand pastes the request and reads the guest-row SAS.
  // Reading it earlier waits on a row that does not exist yet.
  const reply = await ownerAdmitsByHand(
    session.page,
    session.panel,
    request,
    VERIFIED_NAME,
    {
      async beforeAdmit() {
        await joiner.page.getByText("Security code", { exact: true }).click();
        const joinerSas = (
          await joiner.page.locator(".live-sas").innerText()
        ).trim();
        const ownerSas = (
          await session.panel.locator(".vault-row .live-sas").innerText()
        ).trim();
        expect(joinerSas).toMatch(SAS);
        expect(ownerSas).toBe(joinerSas);
        check(
          SAS.test(joinerSas) && joinerSas === ownerSas,
          "verified join shows the same session SAS on both sides",
        );
      },
    },
  );
  await joinerConnects(joiner.page, reply);
  await answerAddresses(joiner.page);
  await opensSharedItems(joiner.page);
  await joiner.page
    .getByRole("img", { name: "Joined Team" })
    .waitFor({ timeout: 45_000 });
  check(true, "copied peer trust signal joins");
  await shot(joiner.page, "verified-join");
  await joiner.context.close();
}

async function crossedSignal(browser, source, target) {
  setStep("mitm");
  console.log("mitm");
  const joiner = await device(browser);
  let request = "";
  try {
    request = await joinerAsks(joiner.page, {
      link: target.link,
      code: target.code,
      name: "Mallory",
      peerTrust: source.signal,
    });
  } catch (error) {
    const words = error instanceof Error ? error.message : String(error);
    const tray = joiner.page.locator(".notice-card, [role=alert]");
    await tray
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    check(
      (await tray.count()) > 0 ||
        (await joiner.page
          .getByRole("img", { name: /peer trust|key changed/i })
          .count()) > 0,
      `crossed signal refused before a request (${words})`,
    );
    check(
      (await joinedMarks(joiner.page).count()) === 0,
      "crossed signal does not join",
    );
    await shot(joiner.page, "mitm-joiner");
    await joiner.context.close();
    return;
  }
  await readRequest(target.panel, request);
  await target.panel
    .getByRole("img", { name: "Not a request code" })
    .waitFor({ timeout: 20_000 });
  check(
    (await joinedMarks(joiner.page).count()) === 0,
    "a signal from the first session does not join the second",
  );
  await shot(target.page, "mitm-owner");
  await shot(joiner.page, "mitm-joiner");
  await joiner.context.close();
}

async function changedKey(browser, session) {
  setStep("changed-key");
  console.log("changed-key");
  const joiner = await device(browser);
  const page = joiner.page;
  await page.goto(session.link, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  const apply = page.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.getByLabel("Your name").waitFor({ timeout: 20_000 });
  const seeded = await seedWrongPeer(page, WRONG_FINGERPRINT);
  check(
    seeded === WRONG_FINGERPRINT,
    "joiner trust store holds a different fingerprint",
  );
  if (session.code)
    await page.getByLabel("Code").fill(session.code.toLowerCase());
  await page.getByLabel("Your name").fill("Casey");
  const pin = page.getByLabel("Your vault PIN", { exact: true });
  if (await pin.isVisible()) {
    await pin.fill(PIN);
    await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
    await page
      .getByLabel("I understand this vault cannot be recovered.", {
        exact: true,
      })
      .check();
  }
  const advanced = page.locator("details.live-advanced").filter({
    has: page.getByLabel("Peer trust signal", { exact: true }),
  });
  if ((await advanced.getAttribute("open")) === null)
    await advanced.locator("summary").click();
  await page
    .getByLabel("Peer trust signal", { exact: true })
    .fill(session.signal);
  const ask = page.getByRole("button", { name: "Ask to join" });
  if (await ask.isEnabled()) await ask.click();
  const alarm = page.getByRole("img", { name: CHANGED });
  const blocked = page.getByRole("button", { name: CHANGED });
  const tray = page.locator(".notice-card").filter({ hasText: CHANGED });
  await alarm.or(blocked).or(tray).first().waitFor({ timeout: 20_000 });
  check(
    (await page
      .getByRole("button", { name: "Copy your join request" })
      .count()) === 0,
    "changed key does not ask",
  );
  await shot(page, "changed-key");
  await joiner.context.close();
}

async function duplicateNames(browser, session) {
  setStep("duplicate-names");
  console.log("duplicate-names");
  const left = await device(browser);
  const right = await device(browser);
  const firstCode = await joinerAsks(left.page, {
    link: session.link,
    code: session.code,
    name: CLASH_NAME,
    peerTrust: session.signal,
  });
  const secondCode = await joinerAsks(right.page, {
    link: session.link,
    code: session.code,
    name: CLASH_NAME,
    peerTrust: session.signal,
  });
  await readRequest(session.panel, firstCode);
  await admitControl(session.panel, CLASH_NAME).waitFor({ timeout: 20_000 });
  await readRequest(session.panel, secondCode);
  await session.panel
    .getByRole("img", { name: "Same display name" })
    .first()
    .waitFor({ timeout: 20_000 });
  check(
    (await session.panel
      .getByRole("img", { name: "Same display name" })
      .count()) > 0,
    "owner shows Same display name",
  );
  await shot(session.page, "duplicate-names");
  await left.context.close();
  await right.context.close();
}

let browser;
try {
  browser = await launch();
  setStep("two-sessions");
  console.log("two-sessions");
  const [first, second] = await Promise.all([
    beginOwner(browser),
    beginOwner(browser),
  ]);
  check(
    SAS.test(first.sas) && SAS.test(second.sas) && first.sas !== second.sas,
    `live SAS differs per session (${first.sas} / ${second.sas})`,
  );
  check(
    first.signal.includes(SIGNAL_KIND) &&
      second.signal.includes(SIGNAL_KIND) &&
      first.signal !== second.signal,
    "each session copies its own peer trust signal",
  );
  await shot(first.page, "session-a");
  await shot(second.page, "session-b");
  await verifiedJoin(browser, first);
  await crossedSignal(browser, first, second);
  await changedKey(browser, second);
  await duplicateNames(browser, second);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const [at, page] of pages.entries()) {
      await shot(page, `failed-${at + 1}`).catch(() => {});
      console.error("peer states", await peerStates(page).catch(() => null));
    }
  }
} finally {
  await browser?.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("peer-trust-two-context ok");
}
