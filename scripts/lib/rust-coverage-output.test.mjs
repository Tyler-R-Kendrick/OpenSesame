import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const command = JSON.parse(readFileSync("package.json", "utf8")).scripts[
  "test:coverage:rust"
];

it("creates an absent output directory before invoking the unchanged Rust collector", () => {
  const directory = mkdtempSync(join(tmpdir(), "rust-coverage-output-"));
  try {
    const cargo = join(directory, "cargo");
    writeFileSync(
      cargo,
      '#!/bin/sh\ntest -d coverage || exit 97\nprintf "%s\\n" "$@" > invocation.txt\nprintf "{\\"collected\\":true}\\n" > coverage/rust-summary.json\n',
    );
    chmodSync(cargo, 0o700);
    const invoke = () =>
      spawnSync("sh", ["-c", command], {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        encoding: "utf8",
      });
    expect(invoke().status).toBe(0);
    expect(
      readFileSync(join(directory, "invocation.txt"), "utf8")
        .trim()
        .split("\n"),
    ).toEqual([
      "+1.88.0",
      "llvm-cov",
      "--workspace",
      "--all-targets",
      "--summary-only",
      "--fail-under-lines",
      "69",
      "--fail-under-functions",
      "67",
      "--json",
      "--output-path",
      "coverage/rust-summary.json",
    ]);
    expect(
      JSON.parse(
        readFileSync(join(directory, "coverage/rust-summary.json"), "utf8"),
      ),
    ).toEqual({ collected: true });
    expect(invoke().status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
