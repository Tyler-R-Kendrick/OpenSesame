#!/usr/bin/env node
/**
 * Red-team mutation harness (S23-E).
 *
 *   node apps/pages/scripts/verify-mutations.mjs [--only <id>]... [--no-build]
 *
 * Breaks one product contract at a time in the source, runs the gate that
 * claims to hold it, and requires that gate to notice. A gate that stays
 * green under its own mutation is reported as a failure of the verification
 * system, not of the mutation.
 *
 * Every mutation is applied to the working tree and taken back with
 * `git checkout --`, so the harness refuses to start unless every file it
 * will touch is clean. It restores on any exit path, including a signal.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTATIONS } from "./lib/mutations.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function parseArgs(argv) {
  const only = [];
  let build = true;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") {
      i += 1;
      only.push(argv[i]);
    } else if (argv[i] === "--no-build") build = false;
  }
  return { only, build };
}

function git(...args) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function assertClean(files) {
  const dirty = git("status", "--porcelain", "--", ...files).stdout.trim();
  if (dirty) {
    console.error(
      `refusing to run: these files are not clean, and the harness restores\nby checking them out.\n${dirty}`,
    );
    process.exit(2);
  }
}

function apply(mutation) {
  const path = resolve(REPO, mutation.file);
  const before = readFileSync(path, "utf8");
  const count = before.split(mutation.find).length - 1;
  if (count !== 1) {
    return `expected its anchor exactly once in ${mutation.file}, found ${count}`;
  }
  writeFileSync(path, before.replace(mutation.find, mutation.replace));
  return null;
}

function restore(files) {
  git("checkout", "--", ...files);
}

function runGate(gate) {
  const result = spawnSync(gate.command, gate.args, {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(gate.env ?? {}),
      NODE_OPTIONS: "--max-old-space-size=8192",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Did the gate notice? `exit` wants a non-zero status; `names` wants a mention. */
function noticed(gate, run) {
  if (gate.kind === "names") {
    return {
      ok: run.output.includes(gate.needle),
      how: `report ${run.output.includes(gate.needle) ? "names" : "never names"} ${gate.needle}`,
    };
  }
  return {
    ok: run.status !== 0,
    how: `gate exited ${run.status}`,
  };
}

const { only, build } = parseArgs(process.argv.slice(2));
const planned = MUTATIONS.filter(
  (m) =>
    (only.length === 0 || only.includes(m.id)) &&
    (build || m.gate.kind !== "names"),
);
if (planned.length === 0) {
  console.error("no mutations selected");
  process.exit(2);
}

const files = [...new Set(planned.map((m) => m.file))];
assertClean(files);

// A signal must not leave a mutated tree behind.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore(files);
    process.exit(130);
  });
}

const results = [];
try {
  for (const mutation of planned) {
    const problem = apply(mutation);
    if (problem) {
      results.push({ id: mutation.id, caught: false, how: problem });
      continue;
    }
    const run = runGate(mutation.gate);
    restore([mutation.file]);
    const verdict = noticed(mutation.gate, run);
    results.push({
      id: mutation.id,
      caught: verdict.ok,
      how: verdict.how,
      gate: mutation.gate.label,
      contract: mutation.contract,
    });
    console.log(
      `${verdict.ok ? "CAUGHT " : "MISSED "} ${mutation.id.padEnd(26)} ${verdict.how}`,
    );
  }
} finally {
  restore(files);
}

const missed = results.filter((r) => !r.caught);
console.log("");
for (const result of missed) {
  console.log(`MISSED ${result.id}`);
  console.log(`  contract: ${result.contract ?? "(mutation did not apply)"}`);
  console.log(`  gate:     ${result.gate ?? "-"}`);
  console.log(`  observed: ${result.how}`);
}
console.log(
  `${results.length - missed.length}/${results.length} mutations caught`,
);
process.exit(missed.length === 0 ? 0 : 1);
