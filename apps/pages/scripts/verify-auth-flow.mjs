// Prove the vault's authentication flow works in a real browser, end to end,
// against the built Pages bundle served at the production origin with no
// backend (the same harness as verify-static-origin.mjs).
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:auth
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import "./lib/expect-timeout.mjs";
import { createAuthFlowHarness } from "./lib/auth-flow-harness.mjs";
import { guestMfaJourney } from "./lib/auth-flow-guest-journey.mjs";
import { lock, openSecurity } from "./lib/auth-flow-nav.mjs";
import { passkeyJourneys } from "./lib/auth-flow-passkey.mjs";
import { pinMfaJourney } from "./lib/auth-flow-pin-journey.mjs";
import { protectorJourney } from "./lib/auth-flow-protector.mjs";
import { totp } from "./lib/totp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.PAGES_VERIFY_DIST ?? path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "auth-flow"),
);
const PIN = "48291037";

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = [];
let step = "boot";
const stepRef = { current: step };
const record = (kind, detail) => log.push({ step, kind, detail });
const failures = [];
function check(condition, what) {
  if (!condition) failures.push(`[${step}] ${what}`);
  record(condition ? "PASS" : "FAIL", what);
}

const { newPage, snap: snapRaw, text } = createAuthFlowHarness({
  DIST,
  ORIGIN,
  BASE,
  OUT,
  record,
});
const snap = (page, name) => {
  step = name;
  stepRef.current = name;
  return snapRaw(page, name, stepRef);
};
const setStep = (name) => {
  step = name;
  stepRef.current = name;
};

const goSecurity = (page) =>
  openSecurity(page, async () => {
    await snap(page, "settings-navigation-failed");
    fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
  });

process.on("unhandledRejection", () => undefined);
const launch = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM) {
  launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
}
const browser = await chromium.launch(launch);

await guestMfaJourney({
  browser,
  newPage,
  check,
  snap,
  goSecurity,
  setStep,
  PIN,
  ORIGIN,
  BASE,
  text,
});

await pinMfaJourney({
  browser,
  newPage,
  check,
  snap,
  goSecurity,
  setStep,
  PIN,
  ORIGIN,
  BASE,
  text,
  totp,
});

await protectorJourney({
  browser,
  newPage,
  check,
  snap,
  setStep,
  openSecurity: goSecurity,
  lock,
  PIN,
  ORIGIN,
  BASE,
  totp,
});

await passkeyJourneys({
  browser,
  newPage,
  check,
  snap,
  setStep,
  lock,
  ORIGIN,
  BASE,
});

await browser.close();
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));

const loopback = log.filter((entry) => entry.kind === "LOOPBACK-REQUEST");
const pageErrors = log.filter((entry) => entry.kind === "PAGE-ERROR");
const consoleErrors = log.filter((entry) => entry.kind === "console-error");
const httpErrors = log.filter((entry) => entry.kind === "HTTP-ERROR");
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
console.log(`loopback requests: ${loopback.length}`);
for (const [name, errors] of [
  ["HTTP", httpErrors],
  ["page", pageErrors],
  ["console", consoleErrors],
]) {
  console.log(
    `${name} errors: ${errors.length}`,
    errors.map((e) => `[${e.step}] ${e.detail.slice(0, 200)}`),
  );
}
const hard = [loopback, pageErrors, consoleErrors, httpErrors].flat().length;
if (failures.length || hard) {
  console.log(
    `\n${failures.length} failed checks, ${hard} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED — artifacts in ${OUT}`);
