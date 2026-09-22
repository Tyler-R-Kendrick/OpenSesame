#!/usr/bin/env node
/**
 * `pnpm verify:sops-browser` — the mandatory local product gate for
 * browser-local SOPS.
 *
 * It runs the engine's type and unit suites, builds the production static
 * application twice (subpath and domain root), drives the compiled app in
 * a real browser against a plain static file server, and records one
 * machine-readable result per acceptance case. No Host is started, no
 * decryption service is stood up, and a static file server plus a test
 * runner are development infrastructure — not a runtime backend.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  const ok = run("engine unit and fixture suites", "pnpm", [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/sops",
    "src/sections/settings/sops",
  ]);
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
      test: "vitest src/lib/sops src/sections/settings/sops",
      command: "pnpm verify:sops-browser",
      runtime: `node ${process.version}`,
      artifact: "docs/evidence/2026-09-22-browser-local-sops/results.json",
      reason: ok ? "Suite passed." : "Suite failed; see the run output.",
    });
  }
}

// ── 2. the compiled static app, in a real browser, both deployments ───
for (const base of ["/OpenSesame/", "/"]) {
  const label = base === "/" ? "domain root" : "subpath";
  const out = join(
    root,
    "artifacts",
    `sops-static${base === "/" ? "-root" : ""}`,
  );
  const built = run(
    `build (${label})`,
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=@opensesame/pages"],
    {
      env: { VITE_BASE: base },
    },
  );
  const drove =
    built &&
    run(
      `static browser gate (${label})`,
      "node",
      ["apps/pages/scripts/verify-sops-static.mjs"],
      {
        env: { VITE_BASE: base, SOPS_VERIFY_OUT: out },
      },
    );
  const status = drove ? "passed" : "failed";
  const cases =
    base === "/"
      ? ["SB-073"]
      : [
          "SB-035",
          "SB-064",
          "SB-067",
          "SB-071",
          "SB-072",
          "SB-074",
          "SB-075",
          "SB-076",
        ];
  for (const caseId of cases) {
    record(caseId, status, {
      evidenceKind: "real-browser",
      test: `verify-sops-static.mjs (base ${base})`,
      command: "pnpm verify:sops-browser",
      runtime: `chromium ${process.env.PLAYWRIGHT_CHROMIUM ?? "bundled"}`,
      artifact: `artifacts/sops-static${base === "/" ? "-root" : ""}/results.json`,
      reason: drove
        ? `The compiled app completed the journeys at base ${base}.`
        : "The static gate failed.",
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
