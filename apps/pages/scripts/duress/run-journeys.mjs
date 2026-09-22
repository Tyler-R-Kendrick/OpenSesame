#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Duress browser journey runner (BROWSER-QA).
 *
 *   PLAYWRIGHT_CHROMIUM=... node apps/pages/scripts/duress/run-journeys.mjs
 *
 * Builds a disposable fixture bundle of real duress modules, launches Chromium
 * when discoverable, and writes evidence under docs/evidence/.../browser/.
 * Never fakes capabilities or production UI entry points.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildDuressFixture } from "./build-fixture.mjs";
import { applyChromiumEnv, findChromium } from "./find-chromium.mjs";
import { walkCapabilities } from "./journeys/capabilities.mjs";
import {
  walkMultiContext,
  walkNetworkLoss,
  walkPeerEnvelope,
  walkRestart,
} from "./journeys/context.mjs";
import {
  walkCryptoSlot,
  walkPrfAndCode,
  walkTrigger,
} from "./journeys/crypto.mjs";
import {
  walkScenarioMatrix,
  walkUiSettings,
} from "./journeys/ui-and-scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
const evidenceDir = path.join(
  root,
  "docs",
  "evidence",
  "2026-09-21-duress",
  "browser",
);
const artifactsDir = path.join(here, ".artifacts");

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(artifactsDir, { recursive: true });

const log = [];
const failures = [];
const blockers = [];
let step = "boot";
const record = (kind, detail) => log.push({ step, kind, detail });
const setStep = (next) => {
  step = next;
};
function check(condition, what) {
  if (!condition) failures.push(`[${step}] ${what}`);
  record(condition ? "PASS" : "FAIL", what);
}

const discovery = applyChromiumEnv(findChromium());
const testedCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

const capabilitiesDoc = {
  schemaVersion: 1,
  testedCommit,
  discoveredAt: new Date().toISOString(),
  chromium: discovery,
  webcrypto: null,
  virtualAuthenticator: null,
  claims: {
    physicalBiometrics: false,
    hardwarePrf: false,
    note: "Virtual authenticator ≠ physical UV; simulated PRF bytes ≠ hardware PRF",
  },
};

if (!discovery.path) {
  blockers.push("no usable Chromium binary discovered");
  const report = {
    schemaVersion: 1,
    outcome: "blocked",
    testedCommit,
    blockers,
    chromium: discovery,
    journeys: [],
    failures,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "capabilities.json"),
    JSON.stringify(capabilitiesDoc, null, 2),
  );
  fs.writeFileSync(
    path.join(evidenceDir, "journeys.json"),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(evidenceDir, "README.md"),
    `# Duress browser evidence

- **Outcome:** blocked — Chromium unavailable
- **Probed paths:** see \`capabilities.json\`
- **Not claimed:** physical biometrics, hardware PRF, production UI arming
`,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

setStep("build-fixture");
let fixture;
try {
  fixture = await buildDuressFixture();
} catch (error) {
  blockers.push(
    `fixture build failed: ${error instanceof Error ? error.message : error}`,
  );
  const report = {
    schemaVersion: 1,
    outcome: "blocked",
    testedCommit,
    blockers,
    chromium: discovery,
    journeys: [],
    failures,
  };
  fs.writeFileSync(
    path.join(evidenceDir, "capabilities.json"),
    JSON.stringify(capabilitiesDoc, null, 2),
  );
  fs.writeFileSync(
    path.join(evidenceDir, "journeys.json"),
    JSON.stringify(report, null, 2),
  );
  console.error(error);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const fixtureOrigin = "https://duress-qa.local/";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".map": "application/json",
};

async function installFixtureRoutes(context) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://duress-qa.local") {
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
        record("LOOPBACK-REQUEST", route.request().url());
      }
      return route.abort("connectionrefused");
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(fixture.outDir, rel);
    if (!fs.existsSync(file)) {
      return route.fulfill({ status: 404, body: "missing" });
    }
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      },
      body: fs.readFileSync(file),
    });
  });
}

async function openFixture(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  await installFixtureRoutes(context);
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    record("PAGE-ERROR", String(error?.stack ?? error).slice(0, 800)),
  );
  await page.goto(fixtureOrigin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__duressQa));
  return { page, context };
}

const browser = await chromium.launch({
  executablePath: discovery.path,
  headless: true,
});

const journeys = [];
async function run(name, fn) {
  setStep(name);
  const started = Date.now();
  try {
    const detail = await fn();
    journeys.push({
      name,
      outcome: "passed",
      ms: Date.now() - started,
      detail: detail ?? null,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`[${name}] ${message}`);
    journeys.push({
      name,
      outcome: "failed",
      ms: Date.now() - started,
      error: message,
    });
    console.error(`FAIL ${name}: ${message}`);
  }
}

try {
  const { page, context } = await openFixture(browser);

  await run("J-CAPABILITIES", async () => {
    const caps = await walkCapabilities({
      page,
      context,
      check,
      record,
    });
    capabilitiesDoc.webcrypto = caps.webcrypto;
    capabilitiesDoc.virtualAuthenticator = caps.virtualAuthenticator;
    return caps;
  });

  await run("J-CRYPTO-SLOT", () => walkCryptoSlot({ page, check }));
  await run("J-PRF-AND-CODE", () => walkPrfAndCode({ page, check }));
  await run("J-TRIGGER", () => walkTrigger({ page, check }));
  await run("J-PEER-ENVELOPE", () => walkPeerEnvelope({ page, check }));
  await run("J-NETWORK-LOSS", () => walkNetworkLoss({ page, check }));
  await run("J-RESTART", () => walkRestart({ page, check }));
  await run("J-SCENARIO-MATRIX", () =>
    walkScenarioMatrix({ page, check, record }),
  );

  await context.close();

  await run("J-MULTI-CONTEXT", () =>
    walkMultiContext({
      browser,
      fixtureOrigin,
      installFixtureRoutes,
      check,
      record,
    }),
  );

  await run("J-UI-SETTINGS", () =>
    walkUiSettings({
      browser,
      check,
      record,
      snap: async (page, name) => {
        setStep(`ui-${name}`);
        const text = await page.evaluate(() => document.body.innerText);
        const safe = name.replace(/[^a-z0-9]+/gi, "_");
        fs.writeFileSync(path.join(artifactsDir, `${safe}.txt`), text);
        await page.screenshot({
          path: path.join(artifactsDir, `${safe}.png`),
          fullPage: true,
        });
        return text;
      },
    }).then((result) => {
      if (result.status === "blocked") {
        blockers.push(...result.blockers);
      }
      return result;
    }),
  );
} finally {
  await browser.close();
}

const pageErrors = log.filter((e) => e.kind === "PAGE-ERROR");
const hard = failures.length + pageErrors.length;
const outcome =
  hard > 0 ? "failed" : blockers.length > 0 ? "passed_with_blockers" : "passed";

const report = {
  schemaVersion: 1,
  outcome,
  testedCommit,
  chromium: discovery,
  blockers,
  journeys,
  failures,
  pageErrors: pageErrors.length,
  contractIds: [
    "INV-01",
    "INV-03",
    "INV-05",
    "INV-08",
    "INV-16",
    "INV-17",
    "BROWSER-QA-A",
    "BROWSER-QA-B",
    "BROWSER-QA-C",
    "BROWSER-QA-D",
    "BROWSER-QA-F",
  ],
};

fs.writeFileSync(
  path.join(evidenceDir, "capabilities.json"),
  JSON.stringify(capabilitiesDoc, null, 2),
);
fs.writeFileSync(
  path.join(evidenceDir, "journeys.json"),
  JSON.stringify(report, null, 2),
);
fs.writeFileSync(
  path.join(artifactsDir, "log.json"),
  JSON.stringify(log, null, 2),
);
fs.writeFileSync(
  path.join(evidenceDir, "README.md"),
  `# Duress browser evidence

- **Outcome:** \`${outcome}\`
- **Chromium:** \`${discovery.path}\` (${discovery.source}) — ${discovery.version ?? "version unknown"}
- **Journeys:** see \`journeys.json\`
- **Capabilities:** see \`capabilities.json\`
- **Blockers:** ${blockers.length ? blockers.map((b) => `\n  - ${b}`).join("") : "none"}
- **Not claimed:** physical biometrics, hardware PRF, hosted CI, production unlock routing until SETTINGS/TRIGGER wire UI
`,
);

console.log(JSON.stringify(report, null, 2));
process.exit(hard > 0 ? 1 : 0);
