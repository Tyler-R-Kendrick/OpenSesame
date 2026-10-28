import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  assertNativeColdBuildHost,
  nativeDistributionDirectory,
  prepareNativeDistribution,
} from "./prepare-distribution.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** Tiny genuine WASM is an integrity fixture; it is not a Tailscale/network proof. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opensesame-native-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const here = join(root, "tools/pwa-tailscale-native-http");
  await mkdir(here, { recursive: true });
  const patch = Buffer.from("fixture patch\n");
  await writeFile(join(here, "exit-route.patch"), patch);
  const overlay = Buffer.from("package nativehttp\n");
  await writeFile(join(here, "nativehttp.go"), overlay);
  const source = {
    nativeHttp: { files: [{ path: "nativehttp.go", sha256: hash(overlay) }] },
    nativeBridge: { files: [] },
    nativeNode: {
      files: [],
      stagingHelper: { path: "nativehttp.go", sha256: hash(overlay) },
    },
    toolchainSelection: { files: [] },
    privateLogging: { files: [] },
    publicTrust: { files: [] },
    nativeSSH: {
      patch: { path: "exit-route.patch", sha256: hash(patch) },
      stagingHelper: { path: "nativehttp.go", sha256: hash(overlay) },
    },
    composition: { files: [] },
    patch: { sha256: hash(patch) },
  };
  const sourceBytes = Buffer.from(`${JSON.stringify(source)}\n`);
  await writeFile(join(here, "source.json"), sourceBytes);
  const sourceSha = hash(sourceBytes);
  const raw = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const entries = new Map();
  function asset(prefix, extension, bytes) {
    const sha256 = hash(bytes);
    const path = `tailscale/${prefix}-${sha256.slice(0, 16)}.${extension}`;
    entries.set(path, bytes);
    return { path, sha256, bytes: bytes.length };
  }
  function text(path, value) {
    const bytes = Buffer.from(value);
    entries.set(path, bytes);
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }
  const manifest = {
    sourceCommit: "a".repeat(40),
    compilerCommit: "b".repeat(40),
    publicRootsVersion: "unit-fixture",
    rawWasm: { sha256: hash(raw), bytes: raw.length },
    assets: {
      wasm: asset("main", "wasm.gz", gzipSync(raw)),
      runtime: asset("go-runtime", "js", Buffer.from("globalThis.Go=class{};")),
      nativeHTTP: asset(
        "native-http",
        "js",
        Buffer.from("export const fixture=true;"),
      ),
    },
    license: text("tailscale/LICENSE.txt", "fixture license"),
    upstreamNotices: text(
      "tailscale/OPEN-SOURCE-LICENSES.md",
      "fixture notices",
    ),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const distributionSha = hash(bytes);
  const directory = nativeDistributionDirectory(
    root,
    sourceSha,
    distributionSha,
  );
  await mkdir(join(directory, "tailscale"), { recursive: true });
  await writeFile(join(directory, "native-artifacts.json"), bytes);
  for (const [path, value] of entries)
    await writeFile(join(directory, path), value);
  return { root, here, sourceSha, distributionSha, directory, manifest };
}
test("an automatic cache hit verifies exact inputs/assets without creating download or compiler work", async (t) => {
  const f = await fixture(t);
  const result = await prepareNativeDistribution(
    f.root,
    f.sourceSha,
    f.distributionSha,
  );
  assert.equal(result.directory, f.directory);
  assert.equal(result.assets.size, 5);
  assert.deepEqual(
    await readdir(join(f.root, ".cache/pwa-tailscale-native-http")),
    ["distributions"],
  );
});
test("concurrent normal callers share preparation and preserve complete output", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    prepareNativeDistribution(f.root, f.sourceSha, f.distributionSha),
    prepareNativeDistribution(f.root, f.sourceSha, f.distributionSha),
  ]);
  assert.equal(first.directory, second.directory);
  assert.deepEqual([...first.assets], [...second.assets]);
});
test("changed cached assets fail instead of silently rebuilding or selecting the old npm runtime", async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, f.manifest.assets.runtime.path);
  const bytes = await readFile(path);
  bytes[0] ^= 1;
  await writeFile(path, bytes);
  await assert.rejects(
    prepareNativeDistribution(f.root, f.sourceSha, f.distributionSha),
    /digest differs/,
  );
  assert.deepEqual(
    await readdir(join(f.root, ".cache/pwa-tailscale-native-http")),
    ["distributions"],
  );
});
test("a changed source overlay refuses an otherwise correct cached distribution", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.here, "nativehttp.go"), "package different\n");
  await assert.rejects(
    prepareNativeDistribution(f.root, f.sourceSha, f.distributionSha),
    /digest differs/,
  );
});
test("cache keys accept only fixed digests and remain inside the repository-owned namespace", () => {
  assert.throws(
    () => nativeDistributionDirectory("/repo", "../escape", "a".repeat(64)),
    /pins/,
  );
  assert.equal(
    nativeDistributionDirectory("/repo", "a".repeat(64), "b".repeat(64)),
    join(
      "/repo/.cache/pwa-tailscale-native-http/distributions",
      "a".repeat(64),
      "b".repeat(64),
    ),
  );
});

test("cold preparation rejects unsupported executable hosts before download or compilation", () => {
  assert.doesNotThrow(() => assertNativeColdBuildHost("linux", "x64"));
  for (const [platform, architecture] of [
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ])
    assert.throws(
      () => assertNativeColdBuildHost(platform, architecture),
      /pinned Linux AMD64 build host/,
    );
});
