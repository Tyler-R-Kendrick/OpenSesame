// The transport panel as a static front end must carry it (ADR 0090, the
// mTLS directive's STATIC-CORE and BROWSER-BOUNDARY invariants).
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:transport
//
// Served out of `dist/` under the production origin exactly as
// `verify-static-origin.mjs` serves it; every other origin is refused.
//
//   AT-STATIC-EMPTY     empty runtime endpoints: guest → Settings › Security ›
//                       Transport renders five idle rows and the tab makes
//                       zero requests to any other origin
//   AT-STATIC-BADREMOTE an endpoint that cannot answer, set through the
//                       settings UI: only the observed row degrades; guest,
//                       vault and settings stay complete
//   AT-BROWSER-CACHE    after the status changed, no copy says local data
//                       was erased or that the vault is now TLS-gated
//   AT-BROWSER-UX       keyboard reaches every transport control at 1280
//                       and 390; the phone contract holds at 320/390/430
//                       and landscape in a real coarse-pointer context
//
// Fails on any page error, console error, loopback request, or check below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { addCapability } from "./lib/capability-walk-contract.mjs";
import {
  AUDIT,
  PHONES,
  TOUCH_FLOOR,
  phoneContext,
  recordStop,
} from "./lib/mobile-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  DIMENSIONS,
  NO_SUCH_CLAIM,
  guest,
  measure,
  openSection,
  openTransport,
  tabTo,
  tone,
} from "./lib/transport-journey.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "/tmp/opensesame-transport-verification",
);
const BAD_REMOTE = "https://bad-remote.invalid";
const STATUS = `${BAD_REMOTE}/api/v1/operator/transport/status`;
const VERIFY = `${BAD_REMOTE}/api/v1/operator/transport/verify`;

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

async function verifyKey(page) {
  return page.getByRole("button", { name: /enforcement verification/ });
}

/** AT-STATIC-EMPTY and the keyboard, at one width with a mouse. */
async function emptyJourney(browser, width) {
  const step = `empty-${width}`;
  const { page, context } = await harness.newPage(browser, {
    device: { viewport: { width, height: 900 } },
  });
  setStep(step);
  await guest(page, ORIGIN, BASE);
  await openTransport(page);
  const text = await snap(page, step, { fullPage: false });
  check(/Transport/.test(text), `${width}: Transport panel is on Security`);
  for (const dimension of DIMENSIONS) {
    check(
      (await tone(page, dimension)) === "idle",
      `${width}: ${dimension} row is idle with no endpoint`,
    );
  }
  check(
    (await (await verifyKey(page)).count()) === 0,
    `${width}: no verification key without an endpoint`,
  );
  check(
    (await page
      .locator("#transport [role=alert], #transport .note")
      .count()) === 0,
    `${width}: no error box`,
  );
  check(!NO_SUCH_CLAIM.test(text), `${width}: no false claim on screen`);
  check(
    externalDuring(step).length === 0,
    `${width}: zero requests to any other origin`,
  );
  const m = await measured(page, step);
  check(m.rows.length === 5, `${width}: five rows`);

  const refresh = page.getByRole("button", {
    name: "Refresh transport status",
  });
  await tabTo(page, refresh);
  await expect(refresh).toBeFocused();
  // By id: Security has other panels with an "Identity" field of their own.
  for (const id of [
    "transport-target",
    "transport-policy",
    "transport-execution",
    "transport-identity",
    "transport-trust",
    "transport-profile",
  ]) {
    await tabTo(page, page.locator(`#${id}`));
  }
  await tabTo(page, page.locator("#transport-trust"), "Shift+Tab");
  check(
    true,
    `${width}: Tab reaches refresh and every field; Shift+Tab returns`,
  );
  await context.close();
}

/** AT-STATIC-BADREMOTE, part one: an endpoint that cannot answer, set through the settings file. */
async function configureBadRemote(page) {
  setStep("badremote-configure");
  await guest(page, ORIGIN, BASE);
  await openSection(page, "settings/");
  // Connections is the external-connectors capability's own settings
  // category (ADR 0130), so a device that has approved nothing does not have
  // it. Add it the way a person does, then carry on into the file.
  await addCapability(page, check, snap, "External connectors", "connections/");
  await openSection(page, "settings/");
  await page
    .getByRole("link", { name: "Connections", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  await page
    .getByLabel("settings/connections.yaml")
    .fill(`hostApi: "${BAD_REMOTE}"\n`);
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(400);
  check(
    (await page.locator('[role="alert"]').count()) === 0,
    "the endpoint was accepted by the settings file",
  );
  await page.getByRole("button", { name: "Form", exact: true }).click();
  check(
    externalDuring("badremote-configure").length === 0,
    "setting an endpoint asks it nothing",
  );
}

/** Part two: only the observed row degrades, and verification is one probe. */
async function openDegraded(page) {
  setStep("badremote-open");
  await page
    .getByRole("link", { name: "Security", exact: true })
    .last()
    .click();
  const panel = page.locator("#transport");
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-dimension="observed"]')).toHaveAttribute(
    "data-tone",
    "err",
    { timeout: 15_000 },
  );
  const opened = await snap(page, "badremote-open", { fullPage: false });
  for (const dimension of DIMENSIONS.filter((d) => d !== "observed")) {
    check(
      (await tone(page, dimension)) === "idle",
      `only observed degraded — ${dimension} stays idle`,
    );
  }
  const asked = externalDuring("badremote-open");
  check(
    asked.length === 1 && asked[0] === `GET ${STATUS}`,
    `exactly one status read went to the endpoint (${asked.join(", ")})`,
  );
  check(
    (await (await verifyKey(page)).count()) === 1,
    "verification is offered once an endpoint exists",
  );
  check(
    (await page.locator('[role="alert"]').count()) === 0,
    "a bad endpoint is a glyph, not an alert",
  );
  check(
    !NO_SUCH_CLAIM.test(opened),
    "no false claim after the status degraded",
  );
  await measured(page, "badremote-1280");

  setStep("badremote-verify");
  await (await verifyKey(page)).click();
  await page.waitForTimeout(1500);
  const probed = externalDuring("badremote-verify");
  check(
    probed.length === 1 && probed[0] === `POST ${VERIFY}`,
    "verification is one POST to the endpoint's probe and nothing else",
  );
  check(
    (await tone(page, "enforcement")) === "idle",
    "a probe that cannot run leaves enforcement unverified",
  );
  check((await tone(page, "observed")) === "err", "observed stays degraded");
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

/** AT-BROWSER-UX: the phone contract, in a real touch context. */
async function phoneJourney(browser, phone) {
  const step = `phone-${phone.name}`;
  const { page, context } = await harness.newPage(browser, {
    device: phoneContext(phone),
  });
  setStep(step);
  await guest(page, ORIGIN, BASE, true);
  await openTransport(page, true);
  const result = await page.evaluate(`(${AUDIT})()`);
  recordStop(harness, step, result);
  check(result.coarse, `${phone.name}: measured in a coarse-pointer context`);
  const m = await measured(page, step);
  check(
    m.refresh && m.refresh.w >= TOUCH_FLOOR && m.refresh.h >= TOUCH_FLOOR,
    `${phone.name}: refresh key ${m.refresh?.w}×${m.refresh?.h} meets the ${TOUCH_FLOOR}px floor`,
  );
  check(
    Number.parseFloat(m.selectFont) >= 16,
    `${phone.name}: select ${m.selectFont} will not zoom iOS`,
  );
  await snap(page, step, { fullPage: false });
  check(
    externalDuring(step).length === 0,
    `${phone.name}: zero external requests`,
  );
  await context.close();
}

const browser = await harness.launch();
try {
  for (const width of [1280, 390]) await emptyJourney(browser, width);
  await badRemoteJourney(browser);
  for (const phone of PHONES) await phoneJourney(browser, phone);
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
  /^badremote-(open|verify)$/.test(e.step) &&
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
