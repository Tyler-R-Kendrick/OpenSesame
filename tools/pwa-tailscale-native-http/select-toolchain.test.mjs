import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { nativePatchCommand } from "./apply-native-patch.mjs";
import { selectNativeToolchain } from "./select-toolchain.mjs";

const sourceInput = process.env.PWA_NATIVE_HTTP_SOURCE;
if (!sourceInput)
  throw new Error(
    "Pass the verified upstream source directory as PWA_NATIVE_HTTP_SOURCE.",
  );
const original = resolve(sourceInput);
const here = new URL(".", import.meta.url).pathname;
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
const area = await mkdtemp(join(tmpdir(), "opensesame-native-selection-"));
after(() => rm(area, { recursive: true, force: true }));
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(area, "case-"));
  const source = join(directory, "source");
  const output = join(directory, "output");
  await mkdir(source);
  await mkdir(output);
  for (const name of [
    "go.mod",
    "go.sum",
    "assert_ts_toolchain_match.go",
    "go.toolchain.rev",
  ])
    await copyFile(join(original, name), join(source, name));
  const commands = [];
  return {
    here,
    source,
    output,
    pins: structuredClone(pins),
    commands,
    requireHash: async (path, expected) =>
      assert.equal(await digest(path), expected),
    execute: async (program, args, name, verify) => {
      await verify();
      const command = nativePatchCommand(program, args);
      const result = await new Promise((accept) => {
        const child = spawn(command.program, command.args, {
          cwd: source,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
          timeout: 5000,
          stdio: "ignore",
        });
        child.once("error", (error) => accept({ error, status: null }));
        child.once("close", (status) => accept({ error: undefined, status }));
      });
      commands.push({ name, status: result.status });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      await verify();
    },
  };
}

test("exact real source selection preserves assertion and original manifest bytes/order", async () => {
  const scope = await fixture();
  const flags = await selectNativeToolchain(scope);
  assert.equal(
    flags,
    `-p=2 -buildvcs=false -mod=readonly -modfile=${scope.output}/native.mod`,
  );
  for (const name of ["go.mod", "go.sum", "assert_ts_toolchain_match.go"])
    assert.deepEqual(
      await readFile(join(scope.source, name)),
      await readFile(join(original, name)),
    );
  assert.equal(
    (await readFile(join(scope.source, "go.toolchain.rev"), "utf8")).trim(),
    pins.compiler.commit,
  );
  const before = (await readFile(join(original, "go.sum"), "utf8")).split("\n");
  const after = (
    await readFile(join(scope.output, "native.sum"), "utf8")
  ).split("\n");
  const replacements = new Map(
    pins.toolchainSelection.sumLines.map((line) => [line.before, line.after]),
  );
  assert.deepEqual(
    after,
    before.map((line) => replacements.get(line) ?? line),
  );
  assert.equal(
    after.filter((line, index) => line !== before[index]).length,
    pins.toolchainSelection.sumLines.length,
  );
  const oldMod = await readFile(join(original, "go.mod"), "utf8");
  const newMod = await readFile(join(scope.output, "native.mod"), "utf8");
  let restored = newMod;
  for (const entry of [
    pins.toolchainSelection,
    ...pins.toolchainSelection.dependencies,
  ])
    restored = restored.replace(
      `${entry.module} ${entry.version}`,
      `${entry.module} ${entry.beforeVersion}`,
    );
  assert.equal(restored, oldMod);
  assert.deepEqual(scope.commands, [
    { name: "select-native-toolchain", status: 0 },
  ]);
  await assert.rejects(selectNativeToolchain(scope), {
    name: "AssertionError",
  });
  assert.equal(scope.commands.length, 1);
});

test("different compiler cannot select the reviewed source revision", async () => {
  const scope = await fixture();
  scope.pins.compiler.commit = "wrong";
  await assert.rejects(
    selectNativeToolchain(scope),
    /compiler and owned source revision differ/,
  );
  assert.equal(scope.commands.length, 0);
});

test("changed upstream assertion rejects before source patch or output", async () => {
  const scope = await fixture();
  await writeFile(
    join(scope.source, "assert_ts_toolchain_match.go"),
    "wrong assertion",
  );
  await assert.rejects(selectNativeToolchain(scope), {
    name: "AssertionError",
  });
  await assert.rejects(readFile(join(scope.output, "native.mod")), {
    code: "ENOENT",
  });
  assert.equal(scope.commands.length, 0);
});

test("changed patch or unrelated dependency cannot be applied", async () => {
  const scope = await fixture();
  scope.pins.toolchainSelection.patchSha256 = "wrong";
  await assert.rejects(selectNativeToolchain(scope), {
    name: "AssertionError",
  });
  scope.pins.toolchainSelection.module = "wrong";
  await assert.rejects(selectNativeToolchain(scope), /fixed dependency/);
  assert.equal(scope.commands.length, 0);
});

test("missing or out-of-scope dependency selections fail before writing module files", async () => {
  for (const mutation of [
    (scope) => scope.pins.toolchainSelection.dependencies.pop(),
    (scope) => {
      scope.pins.toolchainSelection.dependencies[0].module =
        "unreviewed.example/module";
    },
  ]) {
    const scope = await fixture();
    mutation(scope);
    await assert.rejects(
      selectNativeToolchain(scope),
      /reviewed fixed modules/,
    );
    await assert.rejects(readFile(join(scope.output, "native.mod")), {
      code: "ENOENT",
    });
    assert.equal(scope.commands.length, 0);
  }
});

test("existing owned module output is never overwritten", async () => {
  const scope = await fixture();
  await writeFile(join(scope.output, "native.mod"), "operator sentinel", {
    flag: "wx",
  });
  await assert.rejects(selectNativeToolchain(scope), { code: "EEXIST" });
  assert.equal(
    await readFile(join(scope.output, "native.mod"), "utf8"),
    "operator sentinel",
  );
  assert.equal(
    (await readFile(join(scope.source, "go.toolchain.rev"), "utf8")).trim(),
    "7275f792d406d3c386cc807937a45a4a7b699d42",
  );
  assert.equal(scope.commands.length, 0);
});
