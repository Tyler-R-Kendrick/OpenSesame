#!/usr/bin/env node
/** Genuine cold four-phase build on the pinned Linux AMD64 compiler. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import { freemem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeSourceInputs } from "../tools/pwa-tailscale-native-http/distribution-cache.mjs";
import { prepareNativeDistribution } from "../tools/pwa-tailscale-native-http/prepare-distribution.mjs";
import { assertNativeTaskResources } from "../tools/pwa-tailscale-native-http/task-resources.mjs";
import {
  assertFreshNativeCache,
  assertNativeCIAdmission,
  assertNativeCIRequest,
  assertNativeFourPhaseProof,
  assertNativePhaseReceipt,
  assertNativePublishedPins,
  nativeSourceSnapshot,
} from "./lib/native-wasm-proof.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(
  process.argv.length,
  2,
  "This fixed build command accepts no arguments",
);
const head = assertNativeCIRequest(process.env);
const cache = join(root, ".cache/pwa-tailscale-native-http");
await assertFreshNativeCache(cache);
const output = join(cache, "ci-evidence");
await mkdir(output, { mode: 0o700, recursive: true });
const receipt = {
  passed: false,
  head,
  runnerOS: process.platform,
  runnerArch: process.arch,
  runnerName: process.env.RUNNER_NAME,
  coldBuild: false,
  qualification:
    "Build-only four-phase native WASM validation; no browser/network/provider acceptance.",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) =>
  writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
let before;
try {
  const disk = await statfs(root, { bigint: true });
  const available = disk.bavail * disk.bsize;
  let memory = freemem();
  try {
    const limit = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
    const used = Number(
      (await readFile("/sys/fs/cgroup/memory.current", "utf8")).trim(),
    );
    if (/^\d+$/.test(limit)) memory = Math.min(memory, Number(limit) - used);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  receipt.admission = {
    availableBytes: String(available),
    memoryBytes: memory,
    requiredFreeBytes: String(27n * 1024n ** 3n),
  };
  assertNativeCIAdmission(process.platform, process.arch, available, memory);
  before = await nativeSourceSnapshot(root, head);
  await save("source-inputs.json", before);
  const metadataPath = join(
    root,
    "apps/pages/src/lib/capabilities/tailscale-artifacts.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const here = join(root, "tools/pwa-tailscale-native-http");
  const pins = await assertNativeSourceInputs(
    here,
    metadata.native.sourceMetadataSha256,
  );
  receipt.sourceMetadataSha256 = metadata.native.sourceMetadataSha256;
  receipt.distributionSha256 = metadata.native.manifestSha256;
  await copyFile(
    join(here, "source.json"),
    join(output, "native-source.json"),
    constants.COPYFILE_EXCL,
  );
  await copyFile(
    metadataPath,
    join(output, "tailscale-artifacts.json"),
    constants.COPYFILE_EXCL,
  );
  const distribution = await prepareNativeDistribution(
    root,
    metadata.native.sourceMetadataSha256,
    metadata.native.manifestSha256,
  );
  const work = join(cache, "work");
  const runs = await readdir(work);
  assert.equal(
    runs.length,
    1,
    "Cold validation must create exactly one owned build",
  );
  const build = join(work, runs[0], "build");
  const result = JSON.parse(await readFile(join(build, "result.json"), "utf8"));
  assertNativeFourPhaseProof(result, pins, distribution.manifest);
  assertNativePublishedPins(metadata, distribution.manifest);
  const artifacts = join(output, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  for (const [entry, phase] of [
    [result.baseline, "baseline"],
    [result.repeated, "baseline-repeat"],
    [result.expanded, "exit-feature"],
    [result.expandedRepeat, "exit-feature-repeat"],
  ]) {
    const name = `${phase}.raw.wasm`;
    const phaseReceipt = JSON.parse(
      await readFile(join(build, `${phase}.json`), "utf8"),
    );
    assertNativePhaseReceipt(
      phaseReceipt,
      phase,
      join(build, "compiler/bin/go"),
      join(build, "artifacts", name),
    );
    await assertNativeTaskResources(cache);
    const bytes = await readFile(join(distribution.directory, name));
    assert.equal(hash(bytes), entry.sha256, "Raw phase artifact differs");
    await copyFile(
      join(distribution.directory, name),
      join(artifacts, name),
      constants.COPYFILE_EXCL,
    );
    await copyFile(
      join(build, `${phase}.json`),
      join(output, `${phase}.json`),
      constants.COPYFILE_EXCL,
    );
  }
  for (const [path, bytes] of distribution.assets) {
    await assertNativeTaskResources(cache);
    const target = join(artifacts, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  await copyFile(
    join(distribution.directory, "native-artifacts.json"),
    join(artifacts, "native-artifacts.json"),
    constants.COPYFILE_EXCL,
  );
  await copyFile(
    join(build, "result.json"),
    join(output, "result.json"),
    constants.COPYFILE_EXCL,
  );
  await assertNativeTaskResources(cache);
  receipt.coldBuild = true;
  receipt.ownedGroupsRemaining = result.ownedGroupsRemaining;
  receipt.passed = true;
} catch (error) {
  receipt.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  try {
    if (before)
      assert.deepEqual(
        await nativeSourceSnapshot(root, head),
        before,
        "Source changed during native validation",
      );
    receipt.sourceUnchanged = Boolean(before);
  } catch (error) {
    receipt.passed = false;
    receipt.sourceUnchanged = false;
    receipt.sourceError = error.message;
    process.exitCode = 1;
  }
  await save("receipt.json", receipt);
}
console.log(
  JSON.stringify({
    passed: receipt.passed,
    coldBuild: receipt.coldBuild,
    head,
  }),
);
