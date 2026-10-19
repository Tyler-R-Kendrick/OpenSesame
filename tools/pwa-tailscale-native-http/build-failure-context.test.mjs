import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildFailureContext } from "./preparation-diagnostics.mjs";

function metadata(text) {
  return JSON.parse(text.split("\n")[1]);
}
test("reports an actual missing executable without replacing the initiating Error or cause", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-build-spawn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(join(directory, "missing-tar"), [], { stdio: "ignore" });
  const error = await new Promise((resolve) => child.once("error", resolve));
  const cause = new Error("private originating cause");
  error.cause = cause;
  const stack = error.stack;
  const command = {
    phase: "extract-source",
    reason: "spawn",
    exitCode: null,
    signal: null,
    spawnCode: error.code,
  };
  const text = nativeBuildFailureContext(error, "extract-source", command);
  assert.equal(metadata(text).errorCode, "ENOENT");
  assert.equal(metadata(text).lastCommand.spawnCode, "ENOENT");
  assert.equal(metadata(text).lastCommand.reason, "spawn");
  assert.equal(metadata(text).lastCommand.exitCode, null);
  assert.match(text, /missing-tar ENOENT/);
  assert.equal(error.cause, cause);
  assert.equal(error.stack, stack);
  assert.equal(command.spawnCode, "ENOENT");
});
test("reports the actual owned child exit separately from the original failure", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(17)"], {
    stdio: "ignore",
  });
  const result = await new Promise((resolve) =>
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })),
  );
  const error = Object.freeze(new Error("extract-source failed"));
  const text = nativeBuildFailureContext(error, "extract-source", {
    phase: "extract-source",
    ...result,
    spawnCode: null,
  });
  assert.equal(metadata(text).lastCommand.exitCode, 17);
  assert.equal(metadata(text).lastCommand.signal, null);
  assert.equal(metadata(text).lastCommand.spawnCode, null);
  assert.match(text, /extract-source failed/);
});
test("retains filesystem preflight codes with no invented child outcome", () => {
  const error = new Error("owned output write failed");
  error.code = "ENOSPC";
  const record = metadata(
    nativeBuildFailureContext(error, "fresh-output", null),
  );
  assert.equal(record.errorCode, "ENOSPC");
  assert.equal(record.lastCommand, null);
});
test("bounds and redacts context without serializing or mutating secret causes", () => {
  const cause = { password: "cause-secret" };
  const error = new Error(
    "proxy=https://user:password@proxy.test/ Authorization: Bearer private-token",
    { cause },
  );
  error.stack += `\n${"x".repeat(10000)}`;
  const original = error.stack;
  const text = nativeBuildFailureContext(error, "fresh-output", null);
  assert.ok(Buffer.byteLength(text) <= 8192);
  assert.doesNotMatch(text, /user:password|private-token|cause-secret/);
  assert.equal(error.stack, original);
  assert.equal(error.cause, cause);
});
