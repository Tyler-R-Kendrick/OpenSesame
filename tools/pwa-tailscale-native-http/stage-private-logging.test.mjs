import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { stagePrivateLogging } from "./stage-private-logging.mjs";

const here = new URL(".", import.meta.url).pathname;
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
const sourceInput = process.env.PWA_NATIVE_HTTP_SOURCE;
if (!sourceInput)
  throw new Error(
    "Pass the verified original-node staged source as PWA_NATIVE_HTTP_SOURCE.",
  );
const original = join(resolve(sourceInput), "cmd/tsconnect/wasm/wasm_js.go");
const base = await mkdtemp(join(tmpdir(), "opensesame-native-logging-"));
after(() => rm(base, { recursive: true, force: true }));
async function fixture() {
  const source = await mkdtemp(join(base, "source-"));
  const target = join(source, "cmd/tsconnect/wasm/wasm_js.go");
  await mkdir(join(source, "cmd/tsconnect/wasm"), { recursive: true });
  await copyFile(original, target);
  const calls = [];
  return {
    here,
    source,
    target,
    pins: structuredClone(pins),
    calls,
    requireHash: async (path, expected) =>
      assert.equal(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        expected,
      ),
    execute: async (program, args, name, verify) => {
      await verify();
      const result = spawnSync(program, args, {
        cwd: source,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        timeout: 5000,
        encoding: "utf8",
      });
      calls.push({ name, status: result.status });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      await verify();
    },
  };
}
test("actual upstream Config.Disabled hunk changes only one field before construction", async () => {
  const scope = await fixture();
  const originalBytes = await readFile(scope.target, "utf8");
  await stagePrivateLogging(scope);
  const selected = await readFile(scope.target, "utf8");
  assert.equal(
    selected.replace(
      "\t\tDisabled:   true, // Browser node diagnostics stay local; never upload credentials/state.\n",
      "",
    ),
    originalBytes,
  );
  assert.equal(scope.calls.length, 1);
  await assert.rejects(stagePrivateLogging(scope), { name: "AssertionError" });
  assert.equal(scope.calls.length, 1);
});
test("changed node source or patch is rejected without a child", async () => {
  const scope = await fixture();
  await writeFile(scope.target, "wrong node");
  await assert.rejects(stagePrivateLogging(scope), { name: "AssertionError" });
  assert.equal(scope.calls.length, 0);
  await copyFile(original, scope.target);
  scope.pins.privateLogging.patchSha256 = "wrong";
  await assert.rejects(stagePrivateLogging(scope), { name: "AssertionError" });
  assert.equal(scope.calls.length, 0);
});
