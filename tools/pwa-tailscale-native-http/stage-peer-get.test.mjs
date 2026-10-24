import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stagePeerGET } from "./stage-peer-get.mjs";
const here = fileURLToPath(new URL(".", import.meta.url));
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
const requireHash = async (path, expected) =>
  assert.equal(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    expected,
  );
test("stages exact peer GET source and rejects a changed staged peer transport", async () => {
  const predecessor = process.env.PWA_NATIVE_PEER_GET_PREDECESSOR;
  assert.ok(
    predecessor,
    "Pass the actual verified private-logging node predecessor; no fallback or skip",
  );
  await requireHash(predecessor, pins.peerGET.patch.beforeSha256);
  const source = await mkdtemp(join(tmpdir(), "native-peer-get-stage-"));
  try {
    await mkdir(join(source, "cmd/tsconnect/nativehttp"), { recursive: true });
    await mkdir(join(source, "cmd/tsconnect/wasm"), { recursive: true });
    const target = join(source, "cmd/tsconnect/wasm/wasm_js.go");
    await copyFile(predecessor, target, constants.COPYFILE_EXCL);
    const execute = async (command, args, _label, verify) => {
      await verify();
      const result = spawnSync(command, args, {
        cwd: source,
        timeout: 30_000,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      await verify();
    };
    const verify = await stagePeerGET({
      here,
      source,
      pins,
      execute,
      requireHash,
    });
    await verify();
    await writeFile(
      join(source, "cmd/tsconnect/nativehttp/peer-get.go"),
      "replacement peer transport",
    );
    await assert.rejects(verify);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
test("refuses an out-of-scope peer source without executing a patch", async () => {
  let patched = false;
  const bad = {
    ...pins,
    peerGET: {
      ...pins.peerGET,
      files: [
        ...pins.peerGET.files,
        { path: "arbitrary.go", sha256: "0".repeat(64) },
      ],
    },
  };
  await assert.rejects(
    stagePeerGET({
      here,
      source: "unused",
      pins: bad,
      execute: async () => {
        patched = true;
      },
      requireHash,
    }),
  );
  assert.equal(patched, false);
});
