/** Build-only admission and proof checks; no installed PWA runtime dependency. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";

export const nativeCIAdmissionBytes = 27n * 1024n ** 3n;

/** Canonical GitHub repository for native PWA CI admission. */
export const nativeCIRepository = "OpenSesame-Labs/OpenSesame";

function assertNativeCITriggerIdentity(env) {
  assert.equal(env.GITHUB_REPOSITORY, nativeCIRepository, "Wrong repository");
  // User-owned repositories report the same login as ACTOR and OWNER.
  // Organization repositories report the org as OWNER and a member as ACTOR.
  if (
    env.GITHUB_ACTOR?.toLowerCase() ===
    env.GITHUB_REPOSITORY_OWNER?.toLowerCase()
  ) {
    return;
  }
  assert.equal(
    env.GITHUB_REPOSITORY_OWNER,
    "OpenSesame-Labs",
    "Only the canonical organization repository may run this build",
  );
}

export function assertNativeCIAdmission(platform, arch, available, memory) {
  assert.equal(platform, "linux", "Pinned native compiler requires Linux");
  assert.equal(arch, "x64", "Pinned native compiler requires AMD64");
  assert(
    available >= nativeCIAdmissionBytes,
    "Cold native CI requires 27 GiB available before starting",
  );
  assert(
    memory >= 4 * 1024 ** 3,
    "Cold native CI requires 4 GiB available memory before starting",
  );
}

export function assertNativeCIRequest(env) {
  assert(
    /^[a-f0-9]{40}$/.test(env.EXPECTED_HEAD ?? ""),
    "Exact source SHA required",
  );
  // A weekly release qualifies an already-admitted, signed main ancestor;
  // the selected source can be older than the controller's event commit.
  // The reusable workflow separately verifies candidate admission and its
  // exact checkout/signature before running this candidate-owned command.
  const weeklyRef = `${env.GITHUB_REPOSITORY}/.github/workflows/release-weekly.yml@refs/heads/main`;
  if (env.GITHUB_WORKFLOW_REF === weeklyRef) {
    assert.equal(env.GITHUB_ACTIONS, "true", "GitHub Actions is required");
    assert.equal(
      env.GITHUB_REF,
      "refs/heads/main",
      "Weekly controller must run on main",
    );
    assert(
      ["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
      "Weekly controller requires an approved event",
    );
    assert(
      /^[a-f0-9]{40}$/.test(env.GITHUB_WORKFLOW_SHA ?? ""),
      "Exact controller SHA required",
    );
    assert.equal(
      env.GITHUB_SHA,
      env.GITHUB_WORKFLOW_SHA,
      "Controller event SHA differs",
    );
    assertNativeCITriggerIdentity(env);
    return env.EXPECTED_HEAD;
  }
  assert.equal(
    env.EXPECTED_HEAD,
    env.GITHUB_SHA,
    "Dispatch SHA must equal the event branch head",
  );
  assertNativeCITriggerIdentity(env);
  assert(
    env.GITHUB_REF?.startsWith("refs/heads/"),
    "An owned repository branch is required",
  );
  assert(
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Only approved push/manual builds are supported",
  );
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch")
    assert.equal(
      env.REQUESTED_HEAD,
      env.EXPECTED_HEAD,
      "Manual dispatch requires the exact explicit source SHA",
    );
  if (env.GITHUB_EVENT_NAME === "push")
    assert(
      env.GITHUB_REF.startsWith("refs/heads/ci/pwa-native-wasm-"),
      "Explicit native CI branch required",
    );
  return env.EXPECTED_HEAD;
}

export async function assertFreshNativeCache(cache) {
  try {
    await lstat(cache);
    assert.fail(
      "Cold validation refuses any existing native cache; never delete or relabel it",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function assertNativeSourceBlob(mode, blob, path, bytes, info) {
  assert(
    mode === "120000"
      ? info.isSymbolicLink()
      : info.isFile() && !info.isSymbolicLink(),
    "Tracked source type differs",
  );
  if (mode !== "120000")
    assert.equal(
      Boolean(info.mode & 0o111),
      mode === "100755",
      "Tracked executable mode differs",
    );
  const current = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.equal(current, blob, `Source bytes differ: ${path}`);
}

export function assertNativePublishedPins(metadata, manifest) {
  assert.equal(
    metadata.sdk.wasmHash,
    manifest.rawWasm.sha256,
    "Published raw WASM pin differs",
  );
  for (const [asset, sdk] of [
    ["wasm", "gzipHash"],
    ["runtime", "runtimeHash"],
    ["nativeHTTP", "nativeHTTPHash"],
  ]) {
    assert.equal(
      metadata.sdk[sdk],
      manifest.assets[asset].sha256,
      "Published asset hash differs",
    );
    assert.equal(
      metadata.assets[asset],
      manifest.assets[asset].path,
      "Published asset path differs",
    );
  }
  assert.equal(
    metadata.assets.license,
    manifest.license.path,
    "Published license path differs",
  );
  assert.equal(
    metadata.assets.notices,
    manifest.upstreamNotices.path,
    "Published notices path differs",
  );
  for (const key of ["sourceCommit", "compilerCommit", "publicRootsVersion"])
    assert.equal(
      metadata.native[key],
      manifest[key],
      "Published native lineage differs",
    );
}

export function assertNativePhaseReceipt(receipt, phase, compiler, artifact) {
  assert.equal(receipt.phase, phase, "Original phase command receipt differs");
  assert.equal(receipt.pass, true, "Original phase command did not pass");
  assert(
    Array.isArray(receipt.command),
    "Original compiler command is missing",
  );
  assert.equal(
    receipt.command[0],
    compiler,
    "Original selected compiler differs",
  );
  assert.equal(
    receipt.command[1],
    "build",
    "Original Go build command differs",
  );
  const index = receipt.command.indexOf("-o");
  assert(index >= 0, "Original output argument missing");
  assert.equal(
    receipt.command[index + 1],
    artifact,
    "Original raw artifact target differs",
  );
}

export function assertNativeFourPhaseProof(result, pins, manifest) {
  const phases = [
    [result.baseline, "baseline"],
    [result.repeated, "baseline-repeat"],
    [result.expanded, "exit-feature"],
    [result.expandedRepeat, "exit-feature-repeat"],
  ];
  assert.equal(result.ownedGroupsRemaining, 0, "Native compiler groups remain");
  assert(
    Array.isArray(result.integrity) && result.integrity.length > 0,
    "Integrity evidence missing",
  );
  assert(
    result.integrity.every((check) => check.pass === true),
    "Native integrity failure",
  );
  for (const [entry, phase] of phases) {
    assert.equal(entry?.phase, phase, "Native phase mismatch");
    assert(
      /^[a-f0-9]{64}$/.test(entry?.sha256 ?? ""),
      "Native phase hash missing",
    );
    for (const side of ["before", "after"])
      assert(
        result.integrity.some(
          (check) => check.stage === `${phase}:${side}` && check.pass === true,
        ),
        "Native phase integrity missing",
      );
  }
  assert.equal(
    result.baseline.sha256,
    result.repeated.sha256,
    "Baseline repetition differs",
  );
  assert.equal(
    result.expanded.sha256,
    result.expandedRepeat.sha256,
    "Feature repetition differs",
  );
  assert.equal(
    manifest.rawWasm.sha256,
    result.expanded.sha256,
    "Raw WASM differs from emitted distribution",
  );
  assert.equal(
    manifest.sourceCommit,
    pins.source.commit,
    "Source lineage differs",
  );
  assert.equal(
    manifest.compilerCommit,
    pins.compiler.commit,
    "Compiler lineage differs",
  );
}

export async function nativeSourceSnapshot(root, expectedHead) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 ** 2,
    });
  assert.equal(
    git(["rev-parse", "HEAD"]).trim(),
    expectedHead,
    "Checked-out head differs",
  );
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=all"]).trim(),
    "",
    "Source checkout is dirty",
  );
  const entries = git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean);
  const snapshot = [];
  for (let start = 0; start < entries.length; start += 16) {
    snapshot.push(
      ...(await Promise.all(
        entries.slice(start, start + 16).map(async (entry) => {
          const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t(.+)$/.exec(
            entry,
          );
          assert(match, "Unsupported tracked source entry");
          const [, mode, blob, path] = match;
          const file = join(root, path);
          let bytes;
          if (mode === "120000") {
            bytes = Buffer.from(await readlink(file));
            assertNativeSourceBlob(mode, blob, path, bytes, {
              isSymbolicLink: () => true,
              isFile: () => false,
            });
          } else {
            // Read the same descriptor the type check used: a path swap
            // between lstat and readFile must not smuggle different bytes
            // into the source snapshot CodeQL and the native build trust.
            const handle = await open(
              file,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const info = await handle.stat();
              bytes = await handle.readFile();
              assertNativeSourceBlob(mode, blob, path, bytes, info);
            } finally {
              await handle.close();
            }
          }
          return {
            path,
            mode,
            blob,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
      )),
    );
  }
  return snapshot;
}
