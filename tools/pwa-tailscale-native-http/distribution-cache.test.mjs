import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  assertNativeSourceInputs,
  readNativeDistribution,
} from "./distribution-cache.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "opensesame-native-cache-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** A valid empty WASM module exercises cache integrity, not Tailscale networking. */
async function fixture(t) {
  const root = await directory(t);
  await mkdir(join(root, "tailscale"));
  const raw = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  async function asset(prefix, extension, bytes) {
    const sha256 = hash(bytes);
    const path = `tailscale/${prefix}-${sha256.slice(0, 16)}.${extension}`;
    await writeFile(join(root, path), bytes);
    return { path, sha256, bytes: bytes.length };
  }
  async function text(path, bytes) {
    await writeFile(join(root, path), bytes);
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }
  const manifest = {
    sourceCommit: "a".repeat(40),
    compilerCommit: "b".repeat(40),
    publicRootsVersion: "unit-fixture",
    rawWasm: { sha256: hash(raw), bytes: raw.length },
    assets: {
      wasm: await asset("main", "wasm.gz", gzipSync(raw)),
      runtime: await asset(
        "go-runtime",
        "js",
        Buffer.from("globalThis.Go=class{};"),
      ),
      nativeHTTP: await asset(
        "native-http",
        "js",
        Buffer.from("export const fixture=true;"),
      ),
    },
    license: await text(
      "tailscale/LICENSE.txt",
      Buffer.from("fixture license"),
    ),
    upstreamNotices: await text(
      "tailscale/OPEN-SOURCE-LICENSES.md",
      Buffer.from("fixture notices"),
    ),
  };
  async function publish() {
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(join(root, "native-artifacts.json"), bytes);
    return hash(bytes);
  }
  return { root, manifest, publish, sha: await publish() };
}
test("accepts a completely pinned distribution and returns every shipped byte", async (t) => {
  const f = await fixture(t);
  const result = await readNativeDistribution(f.root, f.sha);
  assert.equal(result.assets.size, 5);
  assert.deepEqual(result.manifest, f.manifest);
  assert.equal(
    hash(result.assets.get(f.manifest.assets.nativeHTTP.path)),
    f.manifest.assets.nativeHTTP.sha256,
  );
});
test("refuses a modified manifest before trusting new asset digests", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "native-artifacts.json"), "{}\n");
  await assert.rejects(readNativeDistribution(f.root, f.sha), /digest differs/);
});
test("refuses tampered bridge bytes even if their size remains unchanged", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, f.manifest.assets.nativeHTTP.path);
  const bytes = await readFile(path);
  bytes[0] ^= 1;
  await writeFile(path, bytes);
  await assert.rejects(readNativeDistribution(f.root, f.sha), /digest differs/);
});
test("refuses compressed/raw WASM disagreement independently of asset digests", async (t) => {
  const f = await fixture(t);
  f.manifest.rawWasm.sha256 = "0".repeat(64);
  await assert.rejects(
    readNativeDistribution(f.root, await f.publish()),
    /compressed\/raw WASM differs/,
  );
});
test("refuses descriptor traversal and a filename that is not the pinned asset digest", async (t) => {
  const f = await fixture(t);
  f.manifest.assets.nativeHTTP.path = "../foreign.js";
  await assert.rejects(
    readNativeDistribution(f.root, await f.publish()),
    /distribution path/,
  );
  f.manifest.assets.nativeHTTP.path = `tailscale/native-http-${"0".repeat(16)}.js`;
  await assert.rejects(
    readNativeDistribution(f.root, await f.publish()),
    /name is not/,
  );
});
test("refuses symlinked artifact files and asset directories", async (t) => {
  const f = await fixture(t);
  const foreign = await directory(t);
  const path = join(f.root, f.manifest.assets.runtime.path);
  await writeFile(join(foreign, "runtime.js"), await readFile(path));
  await rm(path);
  await symlink(join(foreign, "runtime.js"), path);
  await assert.rejects(readNativeDistribution(f.root, f.sha));
  await rm(join(f.root, "tailscale"), { recursive: true });
  await symlink(foreign, join(f.root, "tailscale"));
  await assert.rejects(
    readNativeDistribution(f.root, f.sha),
    /owned directory/,
  );
});
test("refuses missing notices rather than silently producing a partial distribution", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, f.manifest.upstreamNotices.path));
  await assert.rejects(readNativeDistribution(f.root, f.sha));
});
test("checks exact source overlays, rejects tampering and rejects overlay traversal", async (t) => {
  const root = await directory(t);
  const overlay = Buffer.from("package nativehttp\n");
  const patch = Buffer.from("fixture patch\n");
  await writeFile(join(root, "nativehttp.go"), overlay);
  await writeFile(join(root, "exit-route.patch"), patch);
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
  async function publish() {
    const bytes = Buffer.from(`${JSON.stringify(source)}\n`);
    await writeFile(join(root, "source.json"), bytes);
    return hash(bytes);
  }
  const sha = await publish();
  await assertNativeSourceInputs(root, sha);
  await writeFile(join(root, "nativehttp.go"), "package different\n");
  await assert.rejects(assertNativeSourceInputs(root, sha), /digest differs/);
  source.nativeHttp.files[0].path = "../foreign.go";
  await assert.rejects(
    assertNativeSourceInputs(root, await publish()),
    /source path/,
  );
});

test("cache validation checks peer overlay, patch and staging helper before reuse", async (t) => {
  const root = await directory(t);
  const bytes = Buffer.from("pinned peer source\n");
  const names = ["peer-get.go", "native-peer-get.patch", "stage-peer-get.mjs"];
  for (const name of [...names, "exit-route.patch"])
    await writeFile(join(root, name), bytes);
  const entry = (path) => ({ path, sha256: hash(bytes) });
  const source = {
    nativeHttp: { files: [] },
    nativeBridge: { files: [] },
    nativeNode: { files: [], stagingHelper: entry("exit-route.patch") },
    toolchainSelection: { files: [] },
    privateLogging: { files: [] },
    publicTrust: { files: [] },
    nativeSSH: {
      patch: entry("exit-route.patch"),
      stagingHelper: entry(names[2]),
    },
    composition: { files: [] },
    peerGET: {
      files: [entry(names[0])],
      patch: entry(names[1]),
      stagingHelper: entry(names[2]),
    },
    patch: { sha256: hash(bytes) },
  };
  const input = Buffer.from(`${JSON.stringify(source)}\n`);
  await writeFile(join(root, "source.json"), input);
  await assertNativeSourceInputs(root, hash(input));
  for (const name of names) {
    await writeFile(join(root, name), "changed peer source\n");
    await assert.rejects(
      assertNativeSourceInputs(root, hash(input)),
      /digest differs/,
    );
    await writeFile(join(root, name), bytes);
  }
  await assertNativeSourceInputs(root, hash(input));
});
