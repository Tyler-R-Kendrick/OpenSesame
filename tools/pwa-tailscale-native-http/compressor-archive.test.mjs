import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compressorArchivePin,
  readCompressorArchive,
} from "./compressor-archive.mjs";
import { assertNativeSourceInputs } from "./distribution-cache.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "native-compressor-source-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t) {
  const root = await directory(t);
  const overlay = Buffer.from("package fixture\n");
  const patch = Buffer.from("fixture patch\n");
  await writeFile(join(root, "nativehttp.go"), overlay);
  await writeFile(join(root, "exit-route.patch"), patch);
  await writeFile(
    join(root, compressorArchivePin.path),
    await readCompressorArchive(),
  );
  const file = { path: "nativehttp.go", sha256: hash(overlay) };
  const source = {
    nativeHttp: { files: [file] },
    nativeBridge: { files: [] },
    nativeNode: { files: [], stagingHelper: file },
    toolchainSelection: { files: [] },
    privateLogging: { files: [] },
    publicTrust: { files: [] },
    nativeSSH: { patch: file, stagingHelper: file },
    composition: {
      files: [
        {
          path: compressorArchivePin.path,
          sha256: compressorArchivePin.sha256,
        },
      ],
    },
    patch: { sha256: hash(patch) },
  };
  async function publish() {
    const bytes = Buffer.from(JSON.stringify(source));
    await writeFile(join(root, "source.json"), bytes);
    return hash(bytes);
  }
  return { root, source, publish };
}

test("local official build source has the exact reviewed bytes and provenance", async () => {
  const bytes = await readCompressorArchive();
  assert.equal(bytes.length, 121304);
  assert.equal(
    hash(bytes),
    "eb872b4f0e1f0ebe59c9f7bd8c506c4204893ba6a8492de31df416f0d5170fd0",
  );
  assert.equal(bytes.subarray(0, 2).toString("hex"), "1f8b");
  assert.equal(compressorArchivePin.version, "2.8");
  assert.equal(
    compressorArchivePin.sourceURL,
    "https://zlib.net/pigz/pigz-2.8.tar.gz",
  );
  assert.ok(Object.isFrozen(compressorArchivePin));
});

test("a same-size corruption is rejected before any archive extraction", async (t) => {
  const root = await directory(t);
  const file = join(root, "changed.tar.gz");
  const bytes = await readCompressorArchive();
  bytes[100] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(readCompressorArchive(file), /official pin/);
  assert.deepEqual(await readFile(file), bytes);
});

for (const bytes of [Buffer.from("truncated"), Buffer.alloc(121305)])
  test(`rejects ${bytes.length}-byte input without reading an unbounded source`, async (t) => {
    const root = await directory(t);
    const file = join(root, "wrong-size.tar.gz");
    await writeFile(file, bytes);
    await assert.rejects(readCompressorArchive(file), /size differs/);
    assert.deepEqual(await readFile(file), bytes);
  });

test("rejects symlinked archive input and directories", async (t) => {
  const root = await directory(t);
  const link = join(root, "linked.tar.gz");
  await symlink(new URL(compressorArchivePin.path, import.meta.url), link);
  await assert.rejects(readCompressorArchive(link), /regular owned file/);
  await assert.rejects(readCompressorArchive(root), /regular owned file/);
});

test("source collector fingerprints the exact binary without raising ordinary text bounds", async (t) => {
  const f = await fixture(t);
  await assertNativeSourceInputs(f.root, await f.publish());
  const text = Buffer.alloc(65537, 97);
  await writeFile(join(f.root, "oversized.mjs"), text);
  f.source.composition.files.push({
    path: "oversized.mjs",
    sha256: hash(text),
  });
  await assert.rejects(
    assertNativeSourceInputs(f.root, await f.publish()),
    /Invalid pinned native asset metadata/,
  );
});

test("collector checks the fixed archive descriptor before attempting a file read", async (t) => {
  const f = await fixture(t);
  f.source.composition.files[0].sha256 = "0".repeat(64);
  await rm(join(f.root, compressorArchivePin.path));
  await assert.rejects(
    assertNativeSourceInputs(f.root, await f.publish()),
    /compressor source pin differs/,
  );
});

test("collector refuses truncated, corrupted and symlinked binary source", async (t) => {
  const f = await fixture(t);
  const sha = await f.publish();
  const archive = join(f.root, compressorArchivePin.path);
  await writeFile(archive, "truncated");
  await assert.rejects(assertNativeSourceInputs(f.root, sha), /size differs/);
  const corrupted = await readCompressorArchive();
  corrupted[100] ^= 1;
  await writeFile(archive, corrupted);
  await assert.rejects(assertNativeSourceInputs(f.root, sha), /digest differs/);
  await rm(archive);
  await symlink(new URL(compressorArchivePin.path, import.meta.url), archive);
  await assert.rejects(
    assertNativeSourceInputs(f.root, sha),
    /regular owned files/,
  );
});
