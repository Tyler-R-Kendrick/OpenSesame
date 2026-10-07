import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function run(family, failingCommand = "") {
  const root = mkdtempSync(join(tmpdir(), "os-depth-execution-contract-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const evidence = join(root, "evidence");
  mkdirSync(checkout);
  mkdirSync(bin);
  mkdirSync(evidence, { mode: 0o700 });
  spawnSync("git", ["init", "--quiet", checkout]);
  const command = join(bin, "pnpm");
  writeFileSync(
    command,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$COMMAND_TRACE"\nif [[ "$*" == "$FAILING_COMMAND" ]]; then exit 17; fi\n',
  );
  chmodSync(command, 0o700);
  const result = spawnSync(
    "bash",
    [resolve("scripts/test/test-depth-run.sh"), family],
    {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DEPTH_EVIDENCE: evidence,
        COMMAND_TRACE: join(evidence, "calls"),
        FAILING_COMMAND: failingCommand,
      },
      encoding: "utf8",
    },
  );
  return { result, evidence };
}

describe("test-depth command orchestration (recording fixtures, not tool campaigns)", () => {
  it("keeps an early scanner failure and still executes all independent scans", () => {
    const { result, evidence } = run("scans", "audit:cve-lite");
    expect(result.status).toBe(1);
    expect(
      readFileSync(join(evidence, "calls"), "utf8").trim().split("\n"),
    ).toEqual([
      "audit:cve-lite",
      "audit:osv",
      "audit:ast-grep",
      "audit:gitleaks",
      "audit:semgrep",
      "audit:cargo-audit",
    ]);
    expect(readFileSync(join(evidence, "commands/cve-lite.exit"), "utf8")).toBe(
      "17\n",
    );
    expect(
      readFileSync(join(evidence, "commands/cargo-audit.exit"), "utf8"),
    ).toBe("0\n");
    expect(readFileSync(join(evidence, "family.exit"), "utf8")).toBe("1\n");
  });

  it("requires the actual full verify invocation to succeed", () => {
    expect(run("verify", "verify").result.status).toBe(1);
    const { result, evidence } = run("verify");
    expect(result.status).toBe(0);
    expect(readFileSync(join(evidence, "calls"), "utf8")).toBe("verify\n");
  });

  it("refuses an unknown or omitted family", () => {
    expect(run("not-a-family").result.status).toBe(2);
    expect(run("").result.status).not.toBe(0);
  });
});
