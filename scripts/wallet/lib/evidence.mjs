/**
 * Write docs/evidence/wallet/last-run.json — command results only, no secrets.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{
 *   suite: string,
 *   status: "passed" | "failed" | "blocked" | "skipped-not-applicable",
 *   exitCode: number | null,
 *   reason: string | null,
 *   command: string | null,
 *   durationMs: number | null,
 *   details?: Record<string, string | number | boolean | null | string[]>,
 * }} SuiteResult
 */

/**
 * @typedef {{
 *   generatedAt: string,
 *   head: string | null,
 *   treeDirty: boolean,
 *   invokedAs: string,
 *   mainnet: { ok: boolean, message: string | null, denials: Array<{ source: string, chainId: number }> },
 *   results: SuiteResult[],
 *   ok: boolean,
 *   notes: string[],
 * }} WalletEvidence
 */

/**
 * @param {string} root
 * @param {Omit<WalletEvidence, "generatedAt" | "head" | "treeDirty"> & { generatedAt?: string }} partial
 * @returns {WalletEvidence}
 */
export function writeWalletEvidence(root, partial) {
  const evidenceDir = join(root, "docs", "evidence", "wallet");
  mkdirSync(evidenceDir, { recursive: true });

  /** @type {WalletEvidence} */
  const doc = {
    generatedAt: partial.generatedAt ?? new Date().toISOString(),
    head: gitHead(root),
    treeDirty: gitStatusDigest(root) !== "",
    invokedAs: partial.invokedAs,
    mainnet: partial.mainnet,
    results: partial.results,
    ok: partial.ok,
    notes: partial.notes,
  };

  const path = join(evidenceDir, "last-run.json");
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
}

/**
 * @param {string} root
 * @param {string[]} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ exitCode: number, durationMs: number, stdoutTail: string, stderrTail: string }}
 */
export function runCommand(root, command, opts = {}) {
  const started = Date.now();
  const result = spawnSync(command[0] ?? "false", command.slice(1), {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    env: sanitizeEnv(opts.env ?? process.env),
    maxBuffer: 4 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const exitCode = Number.isFinite(result.status) ? result.status : 1;
  return {
    exitCode,
    durationMs,
    stdoutTail: tail(result.stdout ?? "", 4000),
    stderrTail: tail(result.stderr ?? "", 4000),
  };
}

/**
 * Strip likely secret-bearing env keys from a child env copy.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function sanitizeEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (
      /secret|token|password|private|api[_-]?key|mnemonic|seed|auth/i.test(key)
    ) {
      delete out[key];
    }
  }
  return out;
}

/** @param {string} root */
function gitHead(root) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

/** @param {string} root */
function gitStatusDigest(root) {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return "unknown";
  return (r.stdout ?? "").trim();
}

/** @param {string} text @param {number} max */
function tail(text, max) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export const EVIDENCE_REL = "docs/evidence/wallet/last-run.json";
