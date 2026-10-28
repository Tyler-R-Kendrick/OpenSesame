import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { onTestFinished, it as test } from "vitest";
import {
  assertFreshNativeCache,
  assertNativeCIAdmission,
  assertNativeCIRequest,
  assertNativeFourPhaseProof,
  assertNativePhaseReceipt,
  assertNativePublishedPins,
  assertNativeSourceBlob,
  nativeCIAdmissionBytes,
} from "./native-wasm-proof.mjs";

const root =
  process.env.NATIVE_WASM_REPOSITORY ??
  fileURLToPath(new URL("../../", import.meta.url));
const valid = () => ({
  EXPECTED_HEAD: "a".repeat(40),
  GITHUB_SHA: "a".repeat(40),
  REQUESTED_HEAD: "a".repeat(40),
  GITHUB_ACTOR: "Tyler-R-Kendrick",
  GITHUB_REPOSITORY_OWNER: "Tyler-R-Kendrick",
  GITHUB_REPOSITORY: "Tyler-R-Kendrick/OpenSesame",
  GITHUB_REF: "refs/heads/ci/pwa-native-wasm-reviewed",
  GITHUB_EVENT_NAME: "workflow_dispatch",
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
function evidence() {
  const phases = [
    "baseline",
    "baseline-repeat",
    "exit-feature",
    "exit-feature-repeat",
  ];
  const entries = phases.map((phase, index) => ({
    phase,
    sha256: digest(index < 2 ? "baseline" : "feature"),
  }));
  return {
    result: {
      baseline: entries[0],
      repeated: entries[1],
      expanded: entries[2],
      expandedRepeat: entries[3],
      ownedGroupsRemaining: 0,
      integrity: phases.flatMap((phase) =>
        ["before", "after"].map((side) => ({
          stage: `${phase}:${side}`,
          pass: true,
        })),
      ),
    },
    pins: { source: { commit: "s" }, compiler: { commit: "c" } },
    manifest: {
      sourceCommit: "s",
      compilerCommit: "c",
      rawWasm: { sha256: entries[2].sha256 },
    },
  };
}

test("cold admission preserves the actual 27 GiB task guard and requires native AMD64 resources", async () => {
  const actual = await import(
    pathToFileURL(
      join(root, "tools/pwa-tailscale-native-http/task-resources.mjs"),
    )
  );
  assert.equal(nativeCIAdmissionBytes, actual.NATIVE_TASK_DISK_LIMIT);
  assertNativeCIAdmission(
    "linux",
    "x64",
    nativeCIAdmissionBytes,
    4 * 1024 ** 3,
  );
  for (const args of [
    ["linux", "arm64", nativeCIAdmissionBytes, 4 * 1024 ** 3],
    ["darwin", "x64", nativeCIAdmissionBytes, 4 * 1024 ** 3],
    ["linux", "x64", nativeCIAdmissionBytes - 1n, 4 * 1024 ** 3],
    ["linux", "x64", nativeCIAdmissionBytes, 4 * 1024 ** 3 - 1],
  ])
    assert.throws(() => assertNativeCIAdmission(...args));
});

test("only the owner's exact branch event can reach the fixed build command", () => {
  assert.equal(assertNativeCIRequest(valid()), "a".repeat(40));
  assert.equal(
    assertNativeCIRequest({ ...valid(), GITHUB_EVENT_NAME: "push" }),
    "a".repeat(40),
  );
  for (const patch of [
    { GITHUB_ACTOR: "outside-user" },
    { GITHUB_REPOSITORY: "outside-user/OpenSesame" },
    { GITHUB_REF: "refs/tags/a" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { EXPECTED_HEAD: "b".repeat(40) },
    { REQUESTED_HEAD: "" },
    { REQUESTED_HEAD: "b".repeat(40) },
    { EXPECTED_HEAD: "main" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
  ])
    assert.throws(() => assertNativeCIRequest({ ...valid(), ...patch }));
});

test("an existing empty, populated or symlinked cache never becomes a claimed cold build", async () => {
  const scope = await mkdtemp(join(tmpdir(), "native-ci-cache-"));
  onTestFinished(() => rm(scope, { recursive: true, force: true }));
  await assertFreshNativeCache(join(scope, "missing"));
  await mkdir(join(scope, "empty"));
  await assert.rejects(
    assertFreshNativeCache(join(scope, "empty")),
    /existing native cache/,
  );
  await writeFile(join(scope, "empty", "receipt.json"), "warm");
  await assert.rejects(
    assertFreshNativeCache(join(scope, "empty")),
    /existing native cache/,
  );
  await symlink(join(scope, "missing-target"), join(scope, "link"));
  await assert.rejects(
    assertFreshNativeCache(join(scope, "link")),
    /existing native cache/,
  );
  assert.equal(
    await readFile(join(scope, "empty", "receipt.json"), "utf8"),
    "warm",
  );
});

test("source bytes, executable bit and symlink identity remain tied to exact Git blobs", async () => {
  const scope = await mkdtemp(join(tmpdir(), "native-ci-source-"));
  onTestFinished(() => rm(scope, { recursive: true, force: true }));
  const bytes = Buffer.from("source\n");
  const file = join(scope, "source.mjs");
  await writeFile(file, bytes, { mode: 0o600 });
  const info = await lstat(file);
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assertNativeSourceBlob("100644", blob, "source.mjs", bytes, info);
  assert.throws(() =>
    assertNativeSourceBlob(
      "100644",
      blob,
      "source.mjs",
      Buffer.from("changed"),
      info,
    ),
  );
  assert.throws(() =>
    assertNativeSourceBlob("100755", blob, "source.mjs", bytes, info),
  );
  assert.throws(() =>
    assertNativeSourceBlob("120000", blob, "source.mjs", bytes, info),
  );
});

test("all four real-builder phase receipts and source/compiler lineage are mandatory", () => {
  const good = evidence();
  assertNativeFourPhaseProof(good.result, good.pins, good.manifest);
  const variants = [
    (value) => {
      value.result.repeated.sha256 = "f".repeat(64);
    },
    (value) => {
      value.result.expandedRepeat.sha256 = "e".repeat(64);
    },
    (value) => {
      value.result.baseline.phase = "exit-feature";
    },
    (value) => {
      value.result.ownedGroupsRemaining = 1;
    },
    (value) => {
      value.result.integrity.pop();
    },
    (value) => {
      value.result.integrity[0].pass = false;
    },
    (value) => {
      value.manifest.rawWasm.sha256 = "d".repeat(64);
    },
    (value) => {
      value.manifest.sourceCommit = "other";
    },
    (value) => {
      value.manifest.compilerCommit = "other";
    },
  ];
  for (const mutate of variants) {
    const value = evidence();
    mutate(value);
    assert.throws(() =>
      assertNativeFourPhaseProof(value.result, value.pins, value.manifest),
    );
  }
});

test("original command receipts cannot substitute a failed phase, compiler or output", () => {
  const value = {
    phase: "baseline",
    pass: true,
    command: [
      "/owned/compiler/bin/go",
      "build",
      "-o",
      "/owned/artifacts/baseline.raw.wasm",
    ],
  };
  const check = (receipt) =>
    assertNativePhaseReceipt(
      receipt,
      "baseline",
      "/owned/compiler/bin/go",
      "/owned/artifacts/baseline.raw.wasm",
    );
  check(value);
  for (const patch of [
    { pass: false },
    { phase: "exit-feature" },
    { command: ["/other/go", ...value.command.slice(1)] },
    { command: ["/owned/compiler/bin/go", "test"] },
    { command: ["/owned/compiler/bin/go", "build", "-o", "/other/output"] },
  ])
    assert.throws(() => check({ ...value, ...patch }));
});

test("all published consumer asset hashes, paths and native lineage remain exact", () => {
  const manifest = {
    rawWasm: { sha256: "raw" },
    assets: {
      wasm: { sha256: "gzip", path: "tailscale/wasm" },
      runtime: { sha256: "runtime", path: "tailscale/runtime" },
      nativeHTTP: { sha256: "http", path: "tailscale/http" },
    },
    license: { path: "tailscale/license" },
    upstreamNotices: { path: "tailscale/notices" },
    sourceCommit: "source",
    compilerCommit: "compiler",
    publicRootsVersion: "roots",
  };
  const metadata = {
    sdk: {
      wasmHash: "raw",
      gzipHash: "gzip",
      runtimeHash: "runtime",
      nativeHTTPHash: "http",
    },
    assets: {
      wasm: "tailscale/wasm",
      runtime: "tailscale/runtime",
      nativeHTTP: "tailscale/http",
      license: "tailscale/license",
      notices: "tailscale/notices",
    },
    native: {
      sourceCommit: "source",
      compilerCommit: "compiler",
      publicRootsVersion: "roots",
    },
  };
  assertNativePublishedPins(metadata, manifest);
  for (const [group, keys] of [
    ["sdk", Object.keys(metadata.sdk)],
    ["assets", Object.keys(metadata.assets)],
    ["native", Object.keys(metadata.native)],
  ]) {
    for (const key of keys) {
      const changed = structuredClone(metadata);
      changed[group][key] = "wrong";
      assert.throws(() => assertNativePublishedPins(changed, manifest));
    }
  }
});

test("workflow retains signature, fixed command, original deadlines and exact evidence upload", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/pwa-native-wasm.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /runs-on: ubuntu-24\.04/);
  assert.match(source, /check-merge-group-signature\.mjs/);
  assert.match(source, /workflow_call:/);
  assert.match(source, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(source, /EXPECTED_HEAD: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_HEAD"/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(
    source,
    /timeout --signal=TERM --kill-after=10s 900s node scripts\/ci-native-wasm\.mjs/,
  );
  assert.match(source, /include-hidden-files: true/);
  assert.match(source, /if: always\(\)/);
  assert.match(
    source,
    /\.cache\/pwa-tailscale-native-http\/work\/\*\/build\/logs/,
  );
  assert.doesNotMatch(
    source,
    /actions\/cache|contents: write|self-hosted|pull_request_target|rm -rf/,
  );
});
