import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isString } from "../lib/json-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanSemgrep = {
  results: [],
  errors: [],
  paths: { scanned: ["apps/example.ts"] },
};
const cleanAudit = { vulnerabilities: { found: false, count: 0, list: [] } };

function runGate(
  name,
  { status = 0, report = "{}", prefix = "opensesame-scanner-gate-" } = {},
) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  const checkout = join(fixture, "checkout");
  try {
    for (const directory of [
      "scripts/audit",
      "scripts/lib",
      "tools/security",
      "apps",
      "crates",
      "packages",
    ]) {
      mkdirSync(join(checkout, directory), { recursive: true });
    }
    copyFileSync(
      join(root, "scripts/audit", `${name}-gate.sh`),
      join(checkout, "scripts/audit", `${name}-gate.sh`),
    );
    copyFileSync(
      join(root, "scripts/lib/audit-directory.sh"),
      join(checkout, "scripts/lib/audit-directory.sh"),
    );
    writeFileSync(
      join(checkout, "tools/security/ast-grep-rules.yml"),
      "id: fixture\n",
    );
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    const tool =
      name === "cargo-audit"
        ? "cargo"
        : name === "ast-grep-security"
          ? "ast-grep"
          : "semgrep";
    const executable = join(bin, tool);
    writeFileSync(
      executable,
      `#!/usr/bin/env bash
set -eu
for argument in "$@"; do
  if [[ "$argument" == "-V" ]]; then echo 'fixture'; exit 0; fi
  if [[ "$argument" == --output=* ]]; then
    output=$(printf '%s' "$argument" | cut -c10-)
    printf '%s' "$SCANNER_REPORT" > "$output"
  fi
done
if [[ "$*" == *"--json"* && "$0" == *"cargo" ]]; then printf '%s' "$SCANNER_REPORT"; fi
exit "$SCANNER_STATUS"
`,
    );
    chmodSync(executable, 0o700);
    const result = spawnSync(
      "bash",
      [join(checkout, "scripts/audit", `${name}-gate.sh`)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OPENSESAME_AUDIT_DIR: fixture,
          SCANNER_STATUS: String(status),
          SCANNER_REPORT: isString(report) ? report : JSON.stringify(report),
        },
      },
    );
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("Semgrep requires successful execution and a complete clean report", () => {
  const clean = runGate("semgrep", { report: cleanSemgrep });
  assert.equal(clean.status, 0, clean.stderr);
  for (const status of [1, 2, 3, 7, 127]) {
    assert.notEqual(
      runGate("semgrep", { status, report: cleanSemgrep }).status,
      0,
    );
  }
  for (const report of [
    "",
    "not json",
    {},
    { results: [], errors: [] },
    { ...cleanSemgrep, results: [{}] },
    { ...cleanSemgrep, errors: [{}] },
  ]) {
    assert.notEqual(runGate("semgrep", { report }).status, 0);
  }
});

test("Semgrep permits -V inside the report path", () => {
  const clean = runGate("semgrep", {
    report: cleanSemgrep,
    prefix: "opensesame-scanner-gate-V",
  });
  assert.equal(clean.status, 0, clean.stderr);
});

test("cargo-audit cannot turn a scanner error or malformed report into zero findings", () => {
  const clean = runGate("cargo-audit", { report: cleanAudit });
  assert.equal(clean.status, 0, clean.stderr);
  for (const status of [1, 2, 101]) {
    assert.notEqual(
      runGate("cargo-audit", { status, report: cleanAudit }).status,
      0,
    );
  }
  for (const report of [
    "",
    "not json",
    {},
    { vulnerabilities: {} },
    { vulnerabilities: { count: 0, list: [{}], found: false } },
    { vulnerabilities: { count: 1, list: [{}], found: true } },
  ]) {
    assert.notEqual(runGate("cargo-audit", { report }).status, 0);
  }
});

test("ast-grep findings and errors fail even without recognized output text", () => {
  const clean = runGate("ast-grep-security");
  assert.equal(clean.status, 0, clean.stderr);
  for (const status of [1, 2, 7, 127])
    assert.notEqual(runGate("ast-grep-security", { status }).status, 0);
});
