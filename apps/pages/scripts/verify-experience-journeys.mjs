// Playwright journeys for product-experience paths the built Pages app
// can drive without Host/Identity. Starts with J-CONFIG (Visual/Source
// prefs save surviving lock/unlock/reload).
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=... node apps/pages/scripts/verify-experience-journeys.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkJAppRecipe } from "./lib/j-app-recipe-journey.mjs";
import { walkJApproval } from "./lib/j-approval-journey.mjs";
import { walkJConfig } from "./lib/j-config-journey.mjs";
import { walkJConflict } from "./lib/j-conflict-journey.mjs";
import { walkJExplain } from "./lib/j-explain-journey.mjs";
import { walkJFile } from "./lib/j-file-journey.mjs";
import { walkJHostConfig } from "./lib/j-host-config-journey.mjs";
import { walkJNav } from "./lib/j-nav-journey.mjs";
import { walkJRecovery } from "./lib/j-recovery-journey.mjs";
import { walkJSupport } from "./lib/j-support-journey.mjs";
import { walkJTypes } from "./lib/j-types-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const OUT = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "..", "..", "..", "artifacts", "experience-journeys"),
);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const { log, failures, check, setStep, launch, newPage, snap } = createHarness({
  dist: DIST,
  origin: ORIGIN,
  base: BASE,
  out: OUT,
});

async function runWalk(name, walk) {
  const { page, context } = await newPage(browser);
  setStep(name);
  try {
    await walk({ page, context, origin: ORIGIN, base: BASE, check, snap });
    console.log(`PASS ${name}`);
  } catch (error) {
    const body = await page
      .evaluate(() => document.body.innerText)
      .catch(() => "");
    console.error(
      `${name} threw:`,
      error instanceof Error ? error.message : error,
    );
    console.error(body.slice(0, 2000));
    failures.push(
      `[${name}] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await context.close();
}

const browser = await launch();
try {
  await runWalk("J-CONFIG", walkJConfig);
  await runWalk("J-FILE", walkJFile);
  await runWalk("J-CONFLICT", walkJConflict);
  await runWalk("J-NAV", walkJNav);
  await runWalk("J-APP-RECIPE", walkJAppRecipe);
  await runWalk("J-TYPES", walkJTypes);
  await runWalk("J-HOST-CONFIG", walkJHostConfig);
  await runWalk("J-EXPLAIN", walkJExplain);
  await runWalk("J-APPROVAL", walkJApproval);
  await runWalk("J-RECOVERY", walkJRecovery);
  await runWalk("J-SUPPORT", walkJSupport);
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
const hard = log.filter(
  (entry) =>
    entry.kind === "FAIL" ||
    entry.kind === "PAGE-ERROR" ||
    entry.kind === "LOOPBACK-REQUEST",
);
if (failures.length || hard.length) {
  for (const item of failures) console.error(`FAIL ${item}`);
  for (const entry of hard) {
    console.error(`FAIL [${entry.step}] ${entry.kind}: ${entry.detail}`);
  }
  process.exit(1);
}
console.log(`PASS experience journeys — artifacts in ${OUT}`);
