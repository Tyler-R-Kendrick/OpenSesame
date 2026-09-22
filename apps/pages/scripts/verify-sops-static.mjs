#!/usr/bin/env node
/**
 * The compiled static app doing real SOPS work in a real browser
 * (PWA-02/04, SB-035, SB-071 … SB-075).
 *
 * The journey is the product claim: a person with no account opens an
 * upstream-encrypted file with an identity they type, edits it, saves
 * ciphertext, and encrypts a new document — then does it again with the
 * network switched off, on a page that had never opened the SOPS route.
 *
 *   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
 *   node apps/pages/scripts/verify-sops-static.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStaticServer,
  documentJourney,
  enterAsGuest,
  gotoSecurity,
  launchBrowser,
  newContext,
  newDocumentJourney,
  scanBundle,
} from "./lib/sops-static-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const FIXTURES = path.resolve(
  here,
  "..",
  "src",
  "lib",
  "sops",
  "fixtures",
  "upstream",
);
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.SOPS_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "sops-static"),
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"),
);
const identities = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "identities.json"), "utf8"),
).identities;
const fixture = manifest.cases.find((item) => item.name === "basic-yaml");

const log = [];
const failures = [];
let step = "boot";
const setStep = (next) => {
  step = next;
};
const record = (kind, detail) => log.push({ step, kind, detail });
const check = (condition, what) => {
  if (!condition) failures.push(`[${step}] ${what}`);
  record(condition ? "PASS" : "FAIL", what);
};

const journey = {
  cipher: fs.readFileSync(path.join(FIXTURES, "basic-yaml.enc.yaml"), "utf8"),
  expected: fs.readFileSync(path.join(FIXTURES, "basic-yaml.dec.yaml"), "utf8"),
  identity: identities[fixture.identities[0]].identity,
  recipient: identities[fixture.identities[0]].recipient,
  check,
  record,
  out: OUT,
};

const server = createStaticServer({ dist: DIST, base: BASE, record });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const produced = { online: "", offline: "", created: "" };

// ── A. online, at this deployment's base ──────────────────────────────
{
  const { context, page } = await newContext(browser, {
    origin: ORIGIN,
    record,
  });
  setStep("A-online");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await enterAsGuest(page);
  await gotoSecurity(page);
  produced.online = await documentJourney(page, "A-online", journey);
  setStep("A-online-new");
  produced.created = await newDocumentJourney(page, "A-online-new", journey);
  await context.close();
}

// ── B. installed, then offline, opening the SOPS route for the first time ─
{
  const { context, page } = await newContext(browser, {
    origin: ORIGIN,
    record,
  });
  setStep("B-offline");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  // Let the service worker install and precache before cutting the network.
  const ready = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    return registration ? "ready" : "none";
  });
  record("service-worker", ready);
  check(ready === "ready", "the service worker installed from the static host");
  await page.waitForTimeout(4000);

  await context.setOffline(true);
  record("offline", "context.setOffline(true)");
  // A real reload: the app must boot from the precache with no network.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  check(
    await page.evaluate(() => document.body.innerText.length > 40),
    "the installed app booted offline",
  );
  await enterAsGuest(page);
  await gotoSecurity(page);
  produced.offline = await documentJourney(page, "B-offline", journey);
  await context.setOffline(false);
  await context.close();
}

// ── C. nothing left the origin ────────────────────────────────────────
{
  setStep("C-boundary");
  const count = (kind) => log.filter((entry) => entry.kind === kind).length;
  check(
    count("EXTERNAL-REQUEST") === 0,
    `no request left the app's origin (saw ${count("EXTERNAL-REQUEST")})`,
  );
  check(
    count("PAGE-ERROR") === 0,
    `no page error (saw ${count("PAGE-ERROR")})`,
  );
  check(
    count("MISSING-ASSET") === 0,
    `no missing asset (saw ${count("MISSING-ASSET")})`,
  );
}

// ── D. the shipped bundle names no native runtime ─────────────────────
{
  setStep("D-bundle");
  const offenders = scanBundle(DIST);
  check(
    offenders.length === 0,
    `the bundle names no native SOPS runtime (${offenders.join(", ")})`,
  );
}

await browser.close();
server.close();

check(
  produced.online.length > 0 && produced.offline.length > 0,
  "both the online and offline runs produced ciphertext",
);

fs.writeFileSync(
  path.join(OUT, "log.json"),
  `${JSON.stringify(log, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(OUT, "results.json"),
  `${JSON.stringify(
    {
      base: BASE,
      origin: ORIGIN,
      chromium: process.env.PLAYWRIGHT_CHROMIUM ?? "bundled",
      produced,
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  console.error(
    `sops static gate failed:\n${failures.map((line) => `  ${line}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `sops static gate passed (base ${BASE}) — artifacts in ${path.relative(process.cwd(), OUT)}`,
);
