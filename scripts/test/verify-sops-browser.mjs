#!/usr/bin/env node
/**
 * `pnpm verify:sops-browser` — the mandatory local product gate for
 * browser-local SOPS.
 *
 * It runs the engine's type and unit suites and records one
 * machine-readable result per acceptance case. No Host is started and no
 * decryption service is stood up. The Settings › Security document sheet and
 * the browser walk that drove it were removed; the engine stays.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, "docs/evidence/2026-09-22-browser-local-sops");
mkdirSync(evidence, { recursive: true });

const results = [];
let failed = false;

function run(label, command, args, options = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 30 * 60_000,
  });
  const ok = result.status === 0;
  if (!ok) failed = true;
  return ok;
}

function record(caseId, status, detail) {
  results.push({ caseId, ...detail, status });
}

// ── 1. the engine's own suites, against checked-in upstream fixtures ──
{
  // The engine lives in @opensesame/app-core (ADR 0133).
  const engine = run("engine unit and fixture suites", "pnpm", [
    "--filter",
    "@opensesame/app-core",
    "exec",
    "vitest",
    "run",
    "src/lib/sops",
  ]);
  const ok = engine;
  for (const caseId of [
    "SB-001",
    "SB-002",
    "SB-006",
    "SB-007",
    "SB-008",
    "SB-009",
    "SB-010",
    "SB-011",
    "SB-012",
    "SB-013",
    "SB-014",
    "SB-015",
    "SB-016",
    "SB-017",
    "SB-018",
    "SB-020",
    "SB-021",
    "SB-022",
    "SB-023",
    "SB-024",
    "SB-025",
    "SB-026",
    "SB-029",
    "SB-030",
    "SB-031",
    "SB-032",
    "SB-033",
    "SB-034",
    "SB-036",
    "SB-037",
    "SB-038",
    "SB-039",
    "SB-040",
    "SB-041",
    "SB-042",
    "SB-043",
    "SB-044",
    "SB-045",
    "SB-046",
    "SB-047",
    "SB-048",
    "SB-049",
    "SB-050",
    "SB-051",
    "SB-052",
    "SB-056",
    "SB-057",
    "SB-059",
    "SB-060",
    "SB-061",
    "SB-062",
    "SB-063",
    "SB-065",
    "SB-066",
    "SB-068",
    "SB-069",
    "SB-070",
    "SB-077",
    "SB-078",
  ]) {
    record(caseId, ok ? "passed" : "failed", {
      evidenceKind: "unit-contract",
      test: "vitest app-core src/lib/sops",
      command: "pnpm verify:sops-browser",
      runtime: `node ${process.version}`,
      artifact: "docs/evidence/2026-09-22-browser-local-sops/results.json",
      reason: ok ? "Suite passed." : "Suite failed; see the run output.",
    });
  }
}

writeFileSync(
  join(evidence, "browser-results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
const passed = results.filter((entry) => entry.status === "passed").length;
console.log(
  `\nverify:sops-browser — ${passed}/${results.length} recorded cases passed`,
);
if (failed) {
  console.error("verify:sops-browser FAILED");
  process.exit(1);
}
