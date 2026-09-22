#!/usr/bin/env node
/**
 * mtls-browser-test.mjs — browser capability scenarios (`pnpm test:mtls:browser`).
 *
 * Drives the Pages browser harnesses that belong to the mTLS work with the
 * pinned Chromium (PLAYWRIGHT_CHROMIUM, default /opt/pw-browsers/chromium):
 *
 *   static-origin  apps/pages/scripts/verify-static-origin.mjs   (AT-STATIC-EMPTY: the static
 *                  front end is complete with no backend and no certificate — STATIC-CORE)
 *   transport-ux   apps/pages/scripts/verify-transport.mjs        (SW-PWA: AT-BROWSER-UX,
 *                  AT-EVIDENCE-STALE, AT-BROWSER-CACHE, AT-STATIC-BADREMOTE)
 *   browser-cert   apps/pages/scripts/verify-browser-cert.mjs     (SW-INTEROP: AT-BROWSER-EXTERNAL,
 *                  AT-BROWSER-CORS)
 *
 * A harness that does not exist yet is reported `not_executed` — never
 * `passed`. A harness that exists and fails is `failed`. A missing Chromium is
 * a failure of the whole step (AT-EVIDENCE-NORUN). Prints one
 * `MTLS_SCENARIO {...}` JSON line per scenario and a final
 * `MTLS_TESTS passed=<n> failed=<n> not_executed=<n>` marker for the manifest.
 *
 * Usage: node scripts/mtls-browser-test.mjs [--no-build]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pages = join(root, "apps/pages");
const distDir = join(pages, "dist");
const noBuild = process.argv.includes("--no-build");
const chromium = process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium";
const timeoutMs =
  Number(process.env.OPENSESAME_MTLS_BROWSER_TIMEOUT ?? 600) * 1000;

const SCENARIOS = [
  {
    id: "static-origin",
    script: "scripts/verify-static-origin.mjs",
    scenario_ids: ["AT-STATIC-EMPTY"],
    owner: "existing Pages harness",
  },
  {
    id: "transport-ux",
    script: "scripts/verify-transport.mjs",
    scenario_ids: [
      "AT-BROWSER-UX",
      "AT-EVIDENCE-STALE",
      "AT-BROWSER-CACHE",
      "AT-STATIC-BADREMOTE",
    ],
    owner: "SW-PWA",
  },
  {
    id: "browser-cert",
    script: "scripts/verify-browser-cert.mjs",
    scenario_ids: ["AT-BROWSER-EXTERNAL", "AT-BROWSER-CORS"],
    owner: "SW-INTEROP",
  },
];

const env = {
  ...process.env,
  PLAYWRIGHT_CHROMIUM: chromium,
  VITE_BASE: "/OpenSesame/",
  NODE_OPTIONS: "--max-old-space-size=8192",
};

function emit(record) {
  console.log(`MTLS_SCENARIO ${JSON.stringify(record)}`);
}

function fail(reason) {
  console.error(`mtls-browser: ${reason}`);
  console.log("MTLS_TESTS passed=0 failed=1 not_executed=0");
  process.exit(1);
}

if (!existsSync(chromium))
  fail(
    `PLAYWRIGHT_CHROMIUM not found at ${chromium} — a missing browser is red, not skipped`,
  );

if (!(noBuild && existsSync(distDir))) {
  console.log("==> mtls-browser: building apps/pages (VITE_BASE=/OpenSesame/)");
  try {
    execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=@opensesame/pages"],
      {
        cwd: root,
        env,
        stdio: "inherit",
      },
    );
  } catch (err) {
    fail(
      `apps/pages build failed (exit ${err.status ?? "?"}); no browser scenario can run`,
    );
  }
}

let passed = 0;
let failed = 0;
let notExecuted = 0;
for (const s of SCENARIOS) {
  const path = join(pages, s.script);
  if (!existsSync(path)) {
    notExecuted += 1;
    emit({
      id: s.id,
      scenario_ids: s.scenario_ids,
      result: "not_executed",
      reason: `${s.script} not present (${s.owner})`,
    });
    continue;
  }
  console.log(`==> mtls-browser: ${s.id} (${s.script})`);
  const started = Date.now();
  const r = spawnSync("node", [path], {
    cwd: pages,
    env,
    stdio: "inherit",
    timeout: timeoutMs,
  });
  const duration_ms = Date.now() - started;
  if (r.status === 0) {
    passed += 1;
    emit({
      id: s.id,
      scenario_ids: s.scenario_ids,
      result: "passed",
      duration_ms,
    });
  } else {
    failed += 1;
    emit({
      id: s.id,
      scenario_ids: s.scenario_ids,
      result: "failed",
      reason: r.signal
        ? `killed by ${r.signal}${r.error?.code === "ETIMEDOUT" ? " (timeout)" : ""}`
        : `exit ${r.status}`,
      duration_ms,
    });
  }
}

console.log(
  `MTLS_TESTS passed=${passed} failed=${failed} not_executed=${notExecuted}`,
);
process.exit(failed > 0 ? 1 : 0);
