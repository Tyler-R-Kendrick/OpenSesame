// The browser draws no Transport panel (ADR 0090, the mTLS directive's
// STATIC-CORE and BROWSER-BOUNDARY invariants). Host transport stays on
// the authority plane.
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:transport
//
// Served out of `dist/` under the production origin exactly as
// `verify-static-origin.mjs` serves it; every other origin is refused.
//
//   AT-STATIC-EMPTY     guest → Settings › Security draws no Transport panel,
//                       and the tab makes zero requests to any other origin
//   AT-STATIC-BADREMOTE a hostApi planted only in os-runtime-config.json is
//                       not probed from the page; guest, vault and settings
//                       stay complete (no Endpoints UI — ADR 0090)
//   AT-BROWSER-CACHE    the vault copy claims no erasure and no TLS gate
//   AT-BROWSER-UX       the phone contract holds on Security at 320/390/430
//                       and landscape, with no transport control to measure
//
// Fails on any page error, console error, loopback request, or check below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT,
  PHONES,
  TABLETS,
  phoneContext,
  recordStop,
} from "./lib/mobile-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { createEmptyJourney } from "./lib/transport-empty-journey.mjs";
import {
  NO_SUCH_CLAIM,
  guest,
  measure,
  openSection,
  openSecurity,
} from "./lib/transport-journey.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "/tmp/opensesame-transport-verification",
);
const BAD_REMOTE = "https://bad-remote.invalid";

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const harness = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});
const { log, failures, check, setStep, snap } = harness;
const measurements = {};

/** Requests that left the tab for another origin during `step`. */
const externalDuring = (step) =>
  log
    .filter((e) => e.step === step && e.kind === "external-request")
    .map((e) => e.detail);

async function measured(page, label) {
  const m = await measure(page);
  measurements[label] = m;
  console.log(`measure ${label}: ${JSON.stringify(m)}`);
  return m;
}

const emptyJourney = createEmptyJourney({
  harness,
  origin: ORIGIN,
  base: BASE,
  externalDuring,
  measured,
});

/**
 * AT-STATIC-BADREMOTE, part one: plant a hostApi that cannot answer via the
 * same-origin runtime config only. There is no Settings › Endpoints panel.
 */
async function configureBadRemote(page, step = "badremote-configure") {
  setStep(step);
  await page.route("**/os-runtime-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ hostApi: BAD_REMOTE }),
    });
  });
  await guest(page, ORIGIN, BASE);
  check(
    externalDuring(step).length === 0,
    "a stamped hostApi asks the page nothing on guest entry",
  );
}

/** Part two: a configured endpoint is not probed, and Security has no panel. */
async function openDegraded(page) {
  setStep("badremote-open");
  await openSecurity(page);
  const opened = await snap(page, "badremote-open", { fullPage: false });
  check(
    (await page.locator("#transport").count()) === 0,
    "Security draws no Transport panel after an endpoint is set",
  );
  check(
    externalDuring("badremote-open").length === 0,
    "the page does not probe the endpoint",
  );
  check(!NO_SUCH_CLAIM.test(opened), "no false claim on Security");
  const m = await measured(page, "badremote-1280");
  check(m.panel === null, "no transport panel measured");
  check(m.rows.length === 0, "no status rows measured");
}

/** AT-BROWSER-CACHE: the vault is untouched by a remote that went away. */
async function cacheJourney(page) {
  setStep("cache-vault");
  await openSection(page, "vault/");
  const vault = await snap(page, "cache-vault", { fullPage: false });
  check(
    (await page
      .getByRole("link", { name: "New item", exact: true })
      .count()) === 1,
    "vault still opens with the endpoint down",
  );
  check(/\bguest(-\d+)?\b/.test(vault), "still the guest, still inside");
  check(
    !NO_SUCH_CLAIM.test(vault),
    "vault copy claims no erasure and no TLS gate",
  );
  await page
    .getByRole("button", { name: "Lock vault", exact: true })
    .filter({ visible: true })
    .click();
  await page.waitForTimeout(800);
  const locked = await snap(page, "cache-locked", { fullPage: false });
  check(
    (await page.getByRole("button", { name: /^Unlock$/ }).count()) >= 1,
    "the unlock screen is the same local gate",
  );
  check(
    !/\btransport\b|\bmTLS\b/i.test(locked),
    "the unlock screen says nothing about transport",
  );
  check(
    externalDuring("cache-vault").length === 0,
    "locking asks the endpoint nothing",
  );
}

async function badRemoteJourney(browser) {
  const { page, context } = await harness.newPage(browser);
  await configureBadRemote(page);
  await openDegraded(page);
  await cacheJourney(page);
  await context.close();
}

/**
 * AT-BROWSER-UX: the phone contract on Security. The page draws no Transport
 * panel, empty or with an endpoint set, so there is no transport control to
 * size. The floor is still measured on the page that is there.
 */
async function phoneJourney(browser, phone, configured = false) {
  const step = configured
    ? `phone-configured-${phone.name}`
    : `phone-${phone.name}`;
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  setStep(step);
  if (configured) await configureBadRemote(page, step);
  else await guest(page, ORIGIN, BASE, true);
  await openSecurity(page, true);
  const result = await page.evaluate(`(${AUDIT})()`);
  recordStop(harness, step, result);
  check(result.coarse, `${phone.name}: measured in a coarse-pointer context`);
  const m = await measured(page, step);
  check(m.panel === null, `${phone.name}: no transport panel`);
  check(m.rows.length === 0, `${phone.name}: no status rows`);
  check(m.refresh === null, `${phone.name}: no refresh key`);
  check(m.selectFont === null, `${phone.name}: no transport select`);
  check(
    externalDuring(step).length === 0,
    `${phone.name}: zero requests to any other origin`,
  );
  await snap(page, step, { fullPage: false });
  await context.close();
}

const browser = await harness.launch();
try {
  for (const width of [1280, 390]) await emptyJourney(browser, width);
  await badRemoteJourney(browser);
  for (const phone of PHONES) await phoneJourney(browser, phone);
  await phoneJourney(browser, TABLETS[0], true);
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
fs.writeFileSync(
  path.join(OUT, "measurements.json"),
  JSON.stringify(measurements, null, 2),
);
const hardKinds = [
  "LOOPBACK-REQUEST",
  "PAGE-ERROR",
  "console-error",
  "ON-SCREEN",
];
// The refused endpoint is the point of AT-STATIC-BADREMOTE: Chromium logs
// its own connection-refused line for that one origin, and nothing else.
const expectedRefusal = (e) =>
  e.kind === "console-error" &&
  /^(badremote-(open|verify)|phone-configured-[\w-]+)$/.test(e.step) &&
  /ERR_CONNECTION_REFUSED/.test(e.detail);
const hard = log.filter(
  (e) => hardKinds.includes(e.kind) && !expectedRefusal(e),
);
for (const entry of log)
  if (entry.kind === "PASS" || entry.kind === "FAIL")
    console.log(`${entry.kind} [${entry.step}] ${entry.detail}`);
for (const entry of hard)
  console.log(`${entry.kind} [${entry.step}] ${entry.detail.slice(0, 300)}`);
if (failures.length || hard.length) {
  console.log(
    `\n${failures.length} failed checks, ${hard.length} hard errors — see ${OUT}`,
  );
  process.exit(1);
}
console.log(`\nALL TRANSPORT CHECKS PASSED — artifacts in ${OUT}`);
