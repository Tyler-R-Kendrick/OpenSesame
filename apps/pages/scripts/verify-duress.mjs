#!/usr/bin/env node
/**
 * verify:duress — real local checks for BUILD A–F (not a checklist printer).
 *
 * Required (exit 1 on failure): feature vitest, static source scan, offline probe.
 * Reported (non-blocking while sibling swarms land): contracts fixtures, full
 * duress-*.test.ts, optional Playwright static-origin.
 *
 * Usage: pnpm --filter @opensesame/pages verify:duress
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, "..");
// The duress feature lives in the shared core (ADR 0133).
const core = join(pages, "..", "..", "packages", "app-core");
const root = join(pages, "..", "..");
const evidenceDir = join(root, "docs", "evidence", "2026-09-21-duress");
mkdirSync(evidenceDir, { recursive: true });

/** @typedef {{ id: string, command: string, result: "passed"|"failed"|"blocked", detail: string, exitCode?: number, required?: boolean }} Case */

/** @type {Case[]} */
const cases = [];

/**
 * @param {string} id
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, blockIf?: () => string|null, required?: boolean }} [opts]
 */
function run(id, command, args, opts = {}) {
  const blocked = opts.blockIf?.() ?? null;
  if (blocked) {
    cases.push({
      id,
      command: `${command} ${args.join(" ")}`,
      result: "blocked",
      detail: blocked,
      required: Boolean(opts.required),
    });
    return;
  }
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const ok = result.status === 0;
  cases.push({
    id,
    command: `${command} ${args.join(" ")}`,
    result: ok ? "passed" : "failed",
    exitCode: result.status ?? 1,
    required: Boolean(opts.required),
    detail: ok
      ? "exit 0"
      : `exit ${result.status}\n${(result.stdout ?? "").slice(-2500)}\n${(result.stderr ?? "").slice(-2500)}`,
  });
}

function runStaticFeatureChecks() {
  const featureDir = join(core, "src/lib/duress/feature");
  const violations = [];
  /** @type {string[]} */
  const sources = [];
  for (const name of readdirSync(featureDir)) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const abs = join(featureDir, name);
    if (!statSync(abs).isFile()) continue;
    sources.push(readFileSync(abs, "utf8"));
  }
  const joined = sources.join("\n");
  if (/(?:https?:)?\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(joined)) {
    violations.push("loopback_reference_in_feature_sources");
  }
  if (/mandatory\s+identity|identity\s+required/i.test(joined)) {
    violations.push("mandatory_identity_in_feature_sources");
  }
  if (/fetch\(\s*['"`]https?:\/\//.test(joined)) {
    violations.push("absolute_fetch_in_feature_sources");
  }

  const registry = readFileSync(join(featureDir, "registry.ts"), "utf8");
  if (
    !registry.includes('"duress.peer"') ||
    !registry.includes("optional_peer")
  ) {
    violations.push("registry_missing_peer_mode_gate");
  }
  const format = readFileSync(join(featureDir, "format.ts"), "utf8");
  if (!format.includes("isDuressFeatureEnabled")) {
    violations.push("format_missing_feature_off_refusal");
  }

  const ok = violations.length === 0;
  cases.push({
    id: "BUILD-D-static-constraints",
    command: "inline:feature-source-scan",
    result: ok ? "passed" : "failed",
    exitCode: ok ? 0 : 1,
    required: true,
    detail: ok ? "no violations" : violations.join("; "),
  });
}

run(
  "BUILD-A-F-feature-vitest",
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/lib/duress/feature/feature.test.ts",
    "--maxWorkers=2",
  ],
  { cwd: core, required: true },
);

runStaticFeatureChecks();

run(
  "REDTEAM-vitest",
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/lib/duress/redteam",
    "--maxWorkers=2",
    "--exclude",
    "**/gaps.honest.test.ts",
  ],
  { cwd: core },
);

run("BROWSER-QA-journeys", "node", ["scripts/duress/run-journeys.mjs"], {
  cwd: pages,
});

run(
  "BUILD-B-F-offline-probe",
  "node",
  [join(here, "verify-duress-offline.mjs")],
  { cwd: pages, required: true },
);

// Sibling-swarm suites — reported for COORD; do not fail BUILD gate.
run("REPORT-contracts-duress", "pnpm", [
  "--filter",
  "@opensesame/contracts",
  "test",
  "--",
  "src/duress",
]);

const duressIntegrationTests = readdirSync(join(core, "src/lib/duress"))
  .filter((name) => /^duress-.*\.test\.ts$/.test(name))
  .map((name) => join("src/lib/duress", name));

run(
  "REPORT-duress-integration-vitest",
  "pnpm",
  ["exec", "vitest", "run", ...duressIntegrationTests, "--maxWorkers=2"],
  {
    cwd: core,
    blockIf: () =>
      duressIntegrationTests.length === 0
        ? "no src/lib/duress/duress-*.test.ts files"
        : null,
  },
);

run(
  "REPORT-static-origin-optional",
  "pnpm",
  ["--filter", "@opensesame/pages", "verify:static"],
  {
    blockIf: () => {
      try {
        statSync(join(pages, "dist", "index.html"));
        return null;
      } catch {
        return "dist/ missing — run pages build; BUILD source scan still applies";
      }
    },
  },
);

const requiredFailed = cases.filter((c) => c.required && c.result === "failed");
const summary = {
  schemaVersion: 1,
  swarm: "BUILD",
  testedCommit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  generatedAt: new Date().toISOString(),
  cases,
  counts: {
    passed: cases.filter((c) => c.result === "passed").length,
    failed: cases.filter((c) => c.result === "failed").length,
    blocked: cases.filter((c) => c.result === "blocked").length,
    requiredFailed: requiredFailed.length,
  },
  gate: requiredFailed.length === 0 ? "passed" : "failed",
  notProved: [
    "physical biometric independence",
    "forensic erasure",
    "hardware PRF across real authenticators",
    "live external provider revocation",
    "production unlock UI routing (SETTINGS/TRIGGER bridge)",
  ],
};

const outPath = join(evidenceDir, "verification.json");
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
const buildOut = join(evidenceDir, "verify-duress-build.json");
writeFileSync(buildOut, `${JSON.stringify(summary, null, 2)}\n`);

console.log(JSON.stringify({ gate: summary.gate, counts: summary.counts }));
console.log(`wrote ${outPath}`);
console.log(`wrote ${buildOut}`);

if (requiredFailed.length > 0) process.exit(1);
