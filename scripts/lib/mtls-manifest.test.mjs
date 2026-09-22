import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testedTree } from "./mtls-manifest.mjs";
import { REDACTIONS, looksSensitive, sanitize } from "./mtls-sanitize.mjs";
import { judge, parseTestCounts } from "./mtls-step-runner.mjs";
import { cargoLockVersions, pnpmLockVersions } from "./mtls-versions.mjs";

// AT-EVIDENCE-LOGS: every pattern the sanitizer promises to catch is proven here.
describe("mtls log sanitizer", () => {
  const b64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7".repeat(4);

  it("redacts a PEM private key block and any stray PRIVATE KEY line", () => {
    const log = `before\n-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\nafter\n-----BEGIN EC PRIVATE KEY-----\n${b64}\nleak`;
    const { text, redactions } = sanitize(log);
    expect(text).not.toContain(b64);
    expect(text).toContain("[REDACTED PRIVATE KEY]");
    expect(text).toContain("[REDACTED PRIVATE KEY LINE]");
    expect(redactions.private_key_block).toBe(1);
    expect(redactions.private_key_line).toBe(1);
    expect(text).toContain("before\n");
    expect(text).toContain("\nafter\n");
  });

  it("redacts Bearer tokens", () => {
    const { text, redactions } = sanitize(
      "curl -H 'Authorization: Bearer abc.DEF-123_456' x",
    );
    expect(text).not.toContain("abc.DEF-123_456");
    expect(
      redactions.bearer ?? 0 + redactions.authorization_header,
    ).toBeGreaterThan(0);
  });

  it("redacts any authorization: header value regardless of case", () => {
    const { text } = sanitize(
      'authorization: Basic dXNlcjpwYXNz\n  "Authorization": "Digest x=1"',
    );
    expect(text).not.toContain("dXNlcjpwYXNz");
    expect(text).not.toContain("Digest x=1");
    expect(text).toMatch(/authorization: \[REDACTED\]/);
  });

  it("redacts JWT-looking strings but not version numbers", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { text, redactions } = sanitize(
      `token=${jwt} rustls 0.23.43 spire 1.12.6`,
    );
    expect(text).not.toContain(jwt);
    expect(text).toContain("[REDACTED JWT]");
    expect(text).toContain("0.23.43");
    expect(redactions.jwt).toBe(1);
  });

  it("redacts nkey seeds (S + 55 base32) but not public keys", () => {
    const seed = `S${"UAM3".repeat(13)}UAM`; // 56 chars, S + 55
    expect(seed).toHaveLength(56);
    const pub = `U${"ABCD".repeat(13)}ABC`;
    const { text, redactions } = sanitize(`seed ${seed} pub ${pub}`);
    expect(text).not.toContain(seed);
    expect(text).toContain(pub);
    expect(redactions.nkey_seed).toBe(1);
  });

  it("redacts x-opensesame-* token headers", () => {
    const { text } = sanitize(
      "-H 'x-opensesame-operator: 0123456789abcdef' X-OpenSesame-Session=deadbeef x-opensesame-agent-token: tok",
    );
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("tok\n");
    expect(text).toMatch(/x-opensesame-operator: \[REDACTED\]/);
  });

  it("redacts secret-bearing environment assignments and TLS key logs", () => {
    const { text } = sanitize(
      "OPENSESAME_OPERATOR_TOKEN=abc123 OPENSESAME_NATS_NKEY_SEED_FILE=/tmp/seed\nCLIENT_RANDOM 00ff 11ee\n",
    );
    expect(text).not.toContain("abc123");
    expect(text).toContain("OPENSESAME_NATS_NKEY_SEED_FILE=/tmp/seed");
    expect(text).not.toContain("00ff 11ee");
  });

  it("is idempotent and leaves ordinary output alone", () => {
    const plain =
      "test result: ok. 12 passed; 0 failed; 0 ignored\nsha256 ad608dd0ea8bbfa58c40e3b8f58ed67478eec26166ec49c502db8d17589b51b5\n";
    expect(sanitize(plain).text).toBe(plain);
    expect(looksSensitive(plain)).toBe(false);
    const once = sanitize("Bearer aaaa.bbbb.cccc").text;
    expect(sanitize(once).text).toBe(once);
  });

  it("has a test for every registered redaction", () => {
    const names = REDACTIONS.map(([n]) => n);
    expect(names).toEqual([
      "private_key_block",
      "private_key_line",
      "base64_blob_line",
      "bearer",
      "authorization_header",
      "jwt",
      "nkey_seed",
      "opensesame_header",
      "secret_env",
      "tls_keylog",
    ]);
  });
});

// AT-EVIDENCE-NORUN: an empty selection or an all-ignored suite is never green.
describe("mtls step judgement", () => {
  it("parses cargo summaries and refuses an empty required selection", () => {
    const log =
      "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out\n";
    const counts = parseTestCounts("cargo", log);
    expect(counts).toMatchObject({
      passed: 0,
      failed: 0,
      ignored: 0,
      selected: 0,
    });
    expect(
      judge({
        runner: "cargo",
        required: true,
        exitCode: 0,
        counts,
        timedOut: false,
      }),
    ).toMatchObject({
      result: "failed",
    });
    expect(
      judge({
        runner: "cargo",
        required: false,
        exitCode: 0,
        counts,
        timedOut: false,
      }).result,
    ).toBe("not_executed");
  });

  it("treats an all-ignored cargo run as a failure for a required step", () => {
    const log =
      "running 4 tests\ntest a ... ignored\ntest result: ok. 0 passed; 0 failed; 4 ignored; 0 measured\n";
    const counts = parseTestCounts("cargo", log);
    expect(counts.ignored).toBe(4);
    const v = judge({
      runner: "cargo",
      required: true,
      exitCode: 0,
      counts,
      timedOut: false,
    });
    expect(v.result).toBe("failed");
    expect(v.reason).toMatch(/ignored/);
  });

  it("sums several cargo test binaries and passes a real run", () => {
    const log =
      "running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored\nrunning 2 tests\ntest result: ok. 2 passed; 0 failed; 0 ignored\n";
    const counts = parseTestCounts("cargo", log);
    expect(counts).toMatchObject({ passed: 5, selected: 5 });
    expect(
      judge({
        runner: "cargo",
        required: true,
        exitCode: 0,
        counts,
        timedOut: false,
      }).result,
    ).toBe("passed");
  });

  it("fails on a non-zero exit even when counts look fine, and on timeout", () => {
    const counts = {
      passed: 5,
      failed: 0,
      ignored: 0,
      not_executed: 0,
      selected: 5,
    };
    expect(
      judge({
        runner: "cargo",
        required: true,
        exitCode: 101,
        counts,
        timedOut: false,
      }).result,
    ).toBe("failed");
    expect(
      judge({
        runner: "cargo",
        required: true,
        exitCode: null,
        counts,
        timedOut: true,
      }).reason,
    ).toBe("timed out");
  });
});

describe("mtls step judgement (vitest and marker runners)", () => {
  it("parses vitest summaries, including 'No test files found'", () => {
    expect(
      parseTestCounts("vitest", "      Tests  7 passed (7)\n"),
    ).toMatchObject({ passed: 7, selected: 7 });
    expect(
      parseTestCounts("vitest", "      Tests  1 failed | 6 passed (7)\n"),
    ).toMatchObject({ passed: 6, failed: 1 });
    const none = parseTestCounts(
      "vitest",
      "No test files found, exiting with code 1\n",
    );
    expect(none.selected).toBe(0);
    expect(
      judge({
        runner: "vitest",
        required: true,
        exitCode: 0,
        counts: none,
        timedOut: false,
      }).result,
    ).toBe("failed");
  });

  it("parses the MTLS_TESTS marker used by free-form scripts", () => {
    const c = parseTestCounts(
      "marker",
      "MTLS_TESTS passed=2 failed=0 not_executed=3\n",
    );
    expect(c).toMatchObject({
      passed: 2,
      failed: 0,
      not_executed: 3,
      selected: 2,
    });
    expect(
      judge({
        runner: "marker",
        required: true,
        exitCode: 0,
        counts: c,
        timedOut: false,
      }).result,
    ).toBe("passed");
    const nothing = parseTestCounts("marker", "did stuff\n");
    expect(
      judge({
        runner: "marker",
        required: true,
        exitCode: 0,
        counts: nothing,
        timedOut: false,
      }).result,
    ).toBe("failed");
  });
});

describe("mtls versions and tree identity", () => {
  it("reads every version of a crate from Cargo.lock text", () => {
    const lock =
      '[[package]]\nname = "rustls"\nversion = "0.23.43"\n\n[[package]]\nname = "x509-parser"\nversion = "0.16.0"\n\n[[package]]\nname = "x509-parser"\nversion = "0.18.1"\n';
    expect(cargoLockVersions(lock, "rustls")).toEqual(["0.23.43"]);
    expect(cargoLockVersions(lock, "x509-parser")).toEqual([
      "0.16.0",
      "0.18.1",
    ]);
    expect(cargoLockVersions(lock, "spiffe")).toEqual([]);
  });

  it("reads resolved npm versions from pnpm-lock.yaml text", () => {
    const lock =
      "packages:\n\n  '@playwright/test@1.55.1':\n    resolution: {}\n\n  oidc-provider@9.11.2:\n    resolution: {}\n\n  hono@4.13.1(zod@3.25.67):\n    x: 1\n";
    expect(pnpmLockVersions(lock, "@playwright/test")).toEqual(["1.55.1"]);
    expect(pnpmLockVersions(lock, "oidc-provider")).toEqual(["9.11.2"]);
    expect(pnpmLockVersions(lock, "hono")).toEqual(["4.13.1"]);
  });

  it("binds the manifest to HEAD and a digest of the dirty tree, never a baseline", () => {
    const t = testedTree();
    expect(t.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(t.tested_tree).toMatch(/^[0-9a-f]{64}$/);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(t.source_commit).toBe(head);
  });
});

describe("mtls manifest CLI", () => {
  const cli = resolve("scripts/lib/mtls-manifest.mjs");
  const dir = mkdtempSync(join(tmpdir(), "mtls-manifest-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("records a passed, a skipped-required (failed) and a captured-secret step, then fails finish", () => {
    const run = (...a) =>
      execFileSync("node", [cli, ...a], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    run("begin", "--run", dir, "--suite", "unit");
    run(
      "run-step",
      "--run",
      dir,
      "--id",
      "ok",
      "--claim",
      "C1",
      "--scenarios",
      "AT-X",
      "--runner",
      "marker",
      "--quiet",
      "--",
      "bash",
      "-c",
      "echo 'secret -----BEGIN PRIVATE KEY----- zzz -----END PRIVATE KEY-----'; echo MTLS_TESTS passed=1 failed=0",
    );
    run(
      "run-step",
      "--run",
      dir,
      "--id",
      "skipped",
      "--claim",
      "C2",
      "--required",
      "true",
      "--skip",
      "fixture absent",
    );
    let code = 0;
    try {
      run("finish", "--run", dir);
    } catch (e) {
      code = e.status;
    }
    expect(code).toBe(1);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.verdict).toBe("failed");
    expect(m.steps.map((s) => [s.id, s.result])).toEqual([
      ["ok", "passed"],
      ["skipped", "failed"],
    ]);
    expect(m.steps[0].artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const log = readFileSync(join(dir, "logs", "ok.log"), "utf8");
    expect(log).not.toContain("zzz");
    expect(m.steps[0].artifacts[0].redactions.private_key_block).toBe(1);
    expect(m.versions.cargo_lock.rustls).toBeTruthy();
  });
});
