import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("cargo-audit gate rejects scanner errors despite clean-looking JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cargo-audit-gate-test-"));
  const path = join(directory, "result.txt");
  const output = await open(path, "w", 0o600);
  try {
    const script = fileURLToPath(
      new URL("./cargo-audit-gate.test.sh", import.meta.url),
    );
    const child = spawn("bash", [script], {
      stdio: ["ignore", output.fd, output.fd],
    });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const result = await readFile(path, "utf8");
    assert.equal(status, 0, result);
    assert.match(result, /cargo-audit gate contract: 3 cases passed/);
  } finally {
    await output.close();
    await rm(directory, { recursive: true, force: true });
  }
});
