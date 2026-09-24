#!/usr/bin/env node
/**
 * Deterministic local gate for vault key protection (no production credentials).
 * Emits machine-readable passed | failed | blocked summary.
 *
 * Usage: node scripts/test/verify-key-protection.mjs
 *        pnpm verify:key-protection
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "docs/evidence/2026-09-20-vault-key-protection");
mkdirSync(outDir, { recursive: true });

/** @typedef {{ id: string, command: string, result: "passed"|"failed"|"blocked", detail: string }} Case */

/** @type {Case[]} */
const cases = [];

/**
 * @param {string} id
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, blockIf?: () => string|null }} [opts]
 */
function run(id, command, args, opts = {}) {
  const blocked = opts.blockIf?.() ?? null;
  if (blocked) {
    cases.push({
      id,
      command: `${command} ${args.join(" ")}`,
      result: "blocked",
      detail: blocked,
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
    detail: ok
      ? "exit 0"
      : `exit ${result.status}\n${(result.stdout ?? "").slice(-2000)}\n${(result.stderr ?? "").slice(-2000)}`,
  });
}

run("KP-model-ts", "pnpm", [
  "--filter",
  "@opensesame/pages",
  "exec",
  "vitest",
  "run",
  "src/lib/vault/protection",
  "src/lib/capability-bind.test.ts",
]);

run("KP-cloud-adapters", "pnpm", [
  "--filter",
  "@opensesame/pages",
  "exec",
  "vitest",
  "run",
  "src/lib/vault/protection/adapters",
]);

run("KP-age-keys", "pnpm", [
  "--filter",
  "@opensesame/pages",
  "exec",
  "vitest",
  "run",
  "src/lib/age-keys",
]);

run("KP-rust-human-vault", "cargo", [
  "+1.88.0",
  "test",
  "-p",
  "opensesame-human-vault",
  "root_protection",
  "--",
  "--nocapture",
]);

run("KP-rust-sealed-store", "cargo", [
  "+1.88.0",
  "test",
  "-p",
  "opensesame-sealed-store",
  "root_protection",
  "--",
  "--nocapture",
]);

run(
  "KP-live-aws",
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/vault/protection/adapters/aws-kms.test.ts",
    "-t",
    "aws-kms live",
  ],
  {
    blockIf: () =>
      process.env.OPENSESAME_TEST_AWS_KMS_KEY_ARN
        ? null
        : "OPENSESAME_TEST_AWS_KMS_KEY_ARN unset — live AWS wrap/unwrap not run",
  },
);

run(
  "KP-live-azure",
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/vault/protection/adapters/azure-key-vault-keys.test.ts",
    "-t",
    "azure-key-vault-keys live",
  ],
  {
    blockIf: () =>
      process.env.OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID
        ? null
        : "OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID unset — live Azure wrap/unwrap not run",
  },
);

run(
  "KP-live-gcp",
  "pnpm",
  [
    "--filter",
    "@opensesame/pages",
    "exec",
    "vitest",
    "run",
    "src/lib/vault/protection/adapters/gcp-kms.test.ts",
    "-t",
    "gcp-kms live",
  ],
  {
    blockIf: () =>
      process.env.OPENSESAME_TEST_GCP_KMS_KEY_NAME
        ? null
        : "OPENSESAME_TEST_GCP_KMS_KEY_NAME unset — live GCP wrap/unwrap not run",
  },
);

run(
  "KP-live-piv",
  "cargo",
  [
    "+1.88.0",
    "test",
    "-p",
    "opensesame-sealed-store",
    "piv",
    "--",
    "--nocapture",
  ],
  {
    blockIf: () =>
      process.env.OPENSESAME_TEST_PIV_SERIAL
        ? null
        : "OPENSESAME_TEST_PIV_SERIAL unset — physical PIV suite not run",
  },
);

const summary = {
  commit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  generatedAt: new Date().toISOString(),
  cases,
  counts: {
    passed: cases.filter((c) => c.result === "passed").length,
    failed: cases.filter((c) => c.result === "failed").length,
    blocked: cases.filter((c) => c.result === "blocked").length,
  },
};

const outPath = join(outDir, "verify-key-protection.json");
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.counts));
console.log(`wrote ${outPath}`);

if (summary.counts.failed > 0) process.exit(1);
