import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const root = repoRootFromHere();
const read = (name) =>
  readFileSync(join(root, ".github/workflows", name), "utf8");
const release = read("ci-release-checks.yml");

function job(text, id) {
  return (
    text.split(`\n  ${id}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ""
  );
}

function runBlock(text) {
  return (
    text.split("        run: |\n")[1]?.split(/\n {6}- |\n {2}[a-z]/)[0] ?? ""
  );
}

const green = {
  SUITE: "mutation",
  ADMIT: "success",
  MUTATION: "success",
  SECURITY: "skipped",
  CODEQL: "skipped",
};
const gate = (env) =>
  spawnSync("bash", ["-e", "-c", runBlock(job(release, "gate"))], {
    encoding: "utf8",
    env: { ...process.env, ...green, ...env },
  });

describe("release mode admission executes fail closed", () => {
  it("accepts precisely the complete mutation mode and the complete security mode", () => {
    expect(gate({}).status).toBe(0);
    expect(
      gate({
        SUITE: "security",
        MUTATION: "skipped",
        SECURITY: "success",
        CODEQL: "success",
      }).status,
    ).toBe(0);
  });
  it.each([
    { SUITE: "unknown" },
    { SUITE: "" },
    { ADMIT: "failure" },
    { ADMIT: "skipped" },
    { MUTATION: "skipped" },
    { MUTATION: "cancelled" },
    { MUTATION: "failure" },
    { SECURITY: "success" },
    { CODEQL: "success" },
    {
      SUITE: "security",
      MUTATION: "skipped",
      SECURITY: "success",
      CODEQL: "skipped",
    },
    {
      SUITE: "security",
      MUTATION: "skipped",
      SECURITY: "failure",
      CODEQL: "success",
    },
  ])("rejects incomplete, wrong-mode or unexpected execution %j", (env) => {
    const result = gate(env);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });
  it("requires every declared mutation, security and CodeQL language leg", () => {
    expect(job(release, "mutation")).toContain(
      "check: [mutation-typescript, mutation-duress, mutation-rust]",
    );
    expect(job(release, "security")).toContain(
      "check: [dependencies, sast, secrets, kani, miri, shuttle, fuzz-rust, fuzz-typescript]",
    );
    expect(
      [...read("codeql.yml").matchAll(/- language: ([a-z-]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "actions",
      "javascript-typescript",
      "python",
      "rust",
      "go",
      "java-kotlin",
    ]);
    const codeql = read("codeql.yml");
    expect(job(codeql, "analyze-native-go")).toContain("target: [wasm, host]");
    expect(job(codeql, "verify-sarif")).toContain(
      "needs: [analyze, analyze-native-go]",
    );
    expect(job(codeql, "verify-sarif")).toContain(
      'test "$NATIVE_GO_RESULT" = success',
    );
    expect(job(release, "gate")).toContain(
      "needs: [admit, mutation, security, codeql]",
    );
    expect(job(release, "record")).toContain("needs: gate");
  });
  it("binds tests to source and writes receipts outside immutable payloads", () => {
    for (const id of ["mutation", "security"]) {
      const body = job(release, id);
      expect(body).toContain("ref: ${{ inputs.source_sha }}");
      expect(body).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
      expect(body).toContain(
        'bash scripts/ci/prepare-dbus.sh "$RUNNER_TEMP/opensesame-dbus"',
      );
      expect(body).toContain('source "$RUNNER_TEMP/opensesame-dbus/env.sh"');
      expect(body).not.toContain("sudo apt-get");
      expect(body).not.toContain("ref: ${{ github.sha }}");
      expect(body).toContain("JAZZER_ALLOW_FALLBACK: '0'");
      expect(body).toContain("OPENSESAME_GITLEAKS_HISTORY_FAIL: '1'");
      expect(body).toContain("FUZZ_BATCH_BUDGET: ''");
      expect(body).not.toContain("continue-on-error");
    }
    const record = job(release, "record");
    expect(record).toContain(
      'verify --directory "$RUNNER_TEMP/candidate" --prerequisite-env PREREQUISITE_RECEIPT',
    );
    expect(record).toContain(
      '--needs-env NEEDS_JSON --directory "$RUNNER_TEMP/qualification"',
    );
    expect(record).toContain(
      "path: ${{ runner.temp }}/qualification/receipt.json",
    );
    expect(record).not.toContain("if: always()");
    expect(job(release, "codeql")).toContain("security-events: write");
    expect(job(read("release-weekly.yml"), "security")).toContain(
      "security-events: write",
    );
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opensesame-deep-check-"));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--quiet"]);
  git(["config", "user.name", "CI test fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(directory, "tracked.txt"), "original\n");
  git(["add", "tracked.txt"]);
  git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "commands.log");
  writeFileSync(
    join(bin, "pnpm"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\nif [ "${FAKE_MUTATE:-0}" = 1 ]; then printf changed >> tracked.txt; fi\nexit "${FAKE_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  const runnerTemp = join(directory, "runner");
  mkdirSync(runnerTemp);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: log,
    SOURCE_SHA: git(["rev-parse", "HEAD"]),
    RUNNER_TEMP: runnerTemp,
  };
  return {
    directory,
    log,
    passed: join(runnerTemp, "release-checks/shuttle/passed.txt"),
    run: (mode, extra = {}) =>
      spawnSync("bash", [join(root, "scripts/release/deep-check.sh"), mode], {
        cwd: directory,
        env: { ...environment, ...extra },
        encoding: "utf8",
      }),
  };
}

describe("deep check shell enforces execution and source integrity", () => {
  it("records success only after execution and removes a stale pass on failure", () => {
    const f = fixture();
    try {
      expect(f.run("shuttle").status).toBe(0);
      expect(readFileSync(f.log, "utf8").trim()).toBe("audit:shuttle");
      expect(existsSync(f.passed)).toBe(true);
      expect(f.run("shuttle", { FAKE_STATUS: "9" }).status).not.toBe(0);
      expect(existsSync(f.passed)).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
  it.each([
    ["unknown", {}],
    ["shuttle", { SOURCE_SHA: "0".repeat(40) }],
    ["fuzz-typescript", { JAZZER_ALLOW_FALLBACK: "1" }],
    ["fuzz-rust", { FUZZ_BATCH_BUDGET: "1" }],
    ["secrets", { OPENSESAME_GITLEAKS_HISTORY_FAIL: "0" }],
  ])("rejects %s before forbidden or misbound checks execute", (mode, env) => {
    const f = fixture();
    try {
      const result = f.run(mode, env);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(existsSync(f.log)).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
  it("rejects a check that mutates the selected tracked source", () => {
    const f = fixture();
    try {
      expect(f.run("shuttle", { FAKE_MUTATE: "1" }).status).not.toBe(0);
      expect(existsSync(f.passed)).toBe(false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});

describe("complete coverage and publication boundaries", () => {
  it("preserves exact-source auxiliaries and requires both coverage planes", () => {
    for (const file of [
      "ci-coverage.yml",
      "complete-verify.yml",
      "native-platform-validation.yml",
      "password-parity.yml",
      "container-build-pr.yml",
      "full-suite.yml",
      "pwa-native-wasm.yml",
    ]) {
      const workflow = read(file);
      expect(workflow).toContain("workflow_call:");
      expect(workflow).not.toMatch(/^ {2}(?:push|pull_request|schedule):/m);
      expect(workflow).toContain("ref: ${{ inputs.source_sha }}");
      expect(workflow).not.toContain("ref: ${{ github.sha }}");
      expect(workflow).not.toContain("continue-on-error");
    }
    expect(read("ci-coverage.yml")).toContain("suite: [typescript, rust]");
    expect(read("ci-coverage.yml")).toContain("pnpm test:coverage:ts");
    expect(read("ci-coverage.yml")).toContain("pnpm test:coverage:rust");
    expect(
      read("complete-verify.yml").indexOf("await loadTailscaleAssets();"),
    ).toBeLessThan(read("complete-verify.yml").indexOf("pnpm verify 2>&1"));
  });
  it("reports CodeQL on the actual PR or main commit and qualifies the selected release source", () => {
    const workflow = read("codeql.yml");
    expect(workflow).toContain("workflow_call:");
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]/m);
    expect(workflow).toMatch(/^ {2}pull_request:\n/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(workflow).toMatch(/^ {2}schedule:\n/m);
    expect(workflow).toContain(
      "github.event_name != 'pull_request' || !github.event.pull_request.draft",
    );
    expect(workflow).toContain("ref: ${{ inputs.source_sha || github.sha }}");
    expect(workflow).toContain(
      "ref: ${{ inputs.source_sha && 'refs/heads/main' || github.ref }}",
    );
    expect(workflow).toContain("sha: ${{ inputs.source_sha || github.sha }}");
    // Direct PR/main events upload their own analysis. Go is mapped before its
    // separate upload; candidate calls never overwrite live main.
    expect(workflow).toContain(
      "upload: ${{ (inputs.source_sha || matrix.language == 'go') && 'never' || 'always' }}",
    );
    const analysis = job(workflow, "analyze");
    expect(analysis).toContain(
      "if: ${{ matrix.language == 'go' && !inputs.source_sha }}",
    );
    expect(analysis).toContain(
      "sarif_file: ${{ runner.temp }}/codeql-live-mapped/go.sarif",
    );
    expect(analysis).toContain("output: ${{ runner.temp }}/codeql-results");
    expect(analysis).not.toContain("check-codeql-sarif.mjs");
    expect(analysis).toContain(
      "name: codeql-sarif-${{ matrix.language }}-${{ inputs.source_sha || github.sha }}",
    );
    expect(analysis).toContain("if: always()");
    const native = job(workflow, "analyze-native-go");
    expect(native).toContain("upload: never");
    expect(native).toContain("if: ${{ !inputs.source_sha }}");
    expect(native).toContain(
      "sarif_file: ${{ runner.temp }}/codeql-native-mapped/go.sarif",
    );
    const trusted = job(workflow, "verify-sarif");
    expect(trusted).toContain("if: ${{ always() && inputs.source_sha }}");
    expect(trusted).toContain("needs: [analyze, analyze-native-go]");
    expect(trusted).toContain('test "$ANALYZE_RESULT" = success');
    expect(trusted).toContain('test "$NATIVE_GO_RESULT" = success');
    expect(trusted).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(trusted).toContain("ref: ${{ github.workflow_sha }}");
    expect(trusted).toContain("persist-credentials: false");
    expect(trusted).toContain("scripts/release/check-codeql-artifacts.mjs");
    expect(trusted).toContain("scripts/release/check-codeql-sarif.mjs");
    expect(trusted).toContain("scripts/lib/json-boundary.mjs");
    expect(trusted).toContain(
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    );
    expect(trusted).toContain(
      'pattern: "codeql-sarif-*-${{ inputs.source_sha }}"',
    );
    expect(trusted).toContain(
      'node scripts/release/check-codeql-artifacts.mjs "$RUNNER_TEMP/codeql-release-evidence" "$SOURCE_SHA"',
    );
    expect(workflow).toContain("cancel-in-progress: ${{ !inputs.source_sha }}");
    expect(workflow).not.toContain("continue-on-error");
  });
  it.each([
    "deploy-pages.yml",
    "release-kit.yml",
    "publish-containers.yml",
    "publish-npm.yml",
  ])("%s cannot publish around qualification", (file) => {
    const workflow = read(file);
    expect(workflow).not.toMatch(/^ {2}(?:push|pull_request|schedule):/m);
    expect(workflow).not.toMatch(/(?:contents|pages|packages|id-token): write/);
    expect(workflow).not.toContain("secrets.");
    const result = spawnSync(
      "bash",
      ["-e", "-c", runBlock(job(workflow, "retired"))],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("publisher is retired");
  });
});
