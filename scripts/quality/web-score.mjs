#!/usr/bin/env node
/**
 * Public web-score gate.
 *
 * Measures a deployed URL with Lighthouse and the public Is Agentic report.
 * The gate is intentionally separate from `pnpm verify`: it needs the network,
 * a Chrome binary, and the public Is Agentic service, so it is a delivery check
 * for a published site rather than a hermetic unit gate.
 *
 * Usage:
 *   CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs [url]
 *
 * Defaults to the canonical public score page,
 * https://is-agentic.com/scan/is-agentic.com, and asserts:
 *   - Lighthouse desktop: performance/accessibility/best-practices/SEO = 1.0
 *   - Is Agentic: score = 100
 *
 * The bare homepage is intentionally not the default: its rotating
 * recent-scans strip embeds third-party favicons, so cookies and 404s from
 * unrelated scanned sites make its best-practices score non-deterministic.
 *
 * Reports are written to reports/web-score/ (git-ignored).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentic } from "../lib/web-score-agentic.mjs";
import {
  cleanup,
  cleanupSync,
  startChrome,
  sweepProfiles,
  waitForChrome,
} from "../lib/web-score-browser.mjs";
import { discoverChrome, parseTarget } from "../lib/web-score-common.mjs";
import { runLighthouse } from "../lib/web-score-lighthouse.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reportDir = join(repo, "reports", "web-score");
const lighthouseReport = join(reportDir, "lighthouse-desktop.json");
const agenticReport = join(reportDir, "is-agentic.json");
const defaultTarget = "https://is-agentic.com/scan/is-agentic.com";
const agenticOrigin = "https://is-agentic.com";
const lighthouseTimeoutMs = 240_000;

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`web-score: ${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const attempts = positiveEnv("WEB_SCORE_LIGHTHOUSE_ATTEMPTS", 2);
const agenticMaxAgeMs = positiveEnv(
  "WEB_SCORE_MAX_AGENTIC_AGE_MS",
  6 * 60 * 60 * 1000,
);

let targetUrl;
try {
  targetUrl = parseTarget(
    process.argv[2] ?? process.env.WEB_SCORE_URL ?? defaultTarget,
  );
} catch (error) {
  console.error(`web-score: ${error.message}`);
  process.exit(2);
}

let chrome;
try {
  chrome = discoverChrome();
} catch (error) {
  console.error(`web-score: ${error.message}`);
  process.exit(2);
}

mkdirSync(reportDir, { recursive: true });
rmSync(lighthouseReport, { force: true });
rmSync(agenticReport, { force: true });
sweepProfiles();
const profileDir = mkdtempSync(join(tmpdir(), "web-score-"));
const runId = `${process.pid}-${Date.now()}`;
const lighthouseRunReport = join(reportDir, `lighthouse-${runId}.json`);
const agenticRunReport = join(reportDir, `is-agentic-${runId}.json`);
const children = new Set();
let cleanedUp = false;

function shutdown(code) {
  if (cleanedUp) process.exit(code);
  cleanedUp = true;
  cleanupSync(children, profileDir);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown(signal === "SIGINT" ? 130 : 143));
}

async function main() {
  let failed = false;
  const agenticTarget = `${targetUrl.origin}/`;
  const { child, getError } = startChrome({
    chrome,
    profileDir,
    noSandbox: process.env.WEB_SCORE_NO_SANDBOX === "1",
    children,
  });
  try {
    const port = await waitForChrome(profileDir, child, getError);
    const lighthouse = await runLighthouse({
      targetUrl,
      port,
      reportPath: lighthouseRunReport,
      timeout: lighthouseTimeoutMs,
      attempts,
      children,
    });
    if (!lighthouse.passed) {
      failed = true;
    } else {
      copyFileSync(lighthouseRunReport, lighthouseReport);
      console.log(
        `Lighthouse desktop: ${JSON.stringify(lighthouse.categories)}`,
      );
    }

    const agentic = await checkAgentic({
      origin: agenticOrigin,
      target: agenticTarget,
      maxAgeMs: agenticMaxAgeMs,
      reportPath: agenticRunReport,
    });
    copyFileSync(agenticRunReport, agenticReport);
    console.log(
      `Is Agentic: ${JSON.stringify({
        target: agentic.target,
        score: agentic.score,
        score_label: agentic.score_label,
        scanned_at: agentic.scanned_at,
      })}`,
    );
    if (agentic.score !== 100) {
      console.error(`FAIL: Is Agentic score is ${agentic.score}, expected 100`);
      failed = true;
    }
    if (!failed) {
      console.log(
        `PASS: perfect web scores for ${targetUrl.href}; Is Agentic origin ${agenticTarget}`,
      );
    }
  } finally {
    if (!cleanedUp) {
      cleanedUp = true;
      await cleanup(children, profileDir);
    }
    rmSync(lighthouseRunReport, { force: true });
    rmSync(agenticRunReport, { force: true });
  }
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`web-score: ${error.message}`);
  if (!cleanedUp) {
    cleanedUp = true;
    await cleanup(children, profileDir);
  }
  process.exitCode = 1;
}
