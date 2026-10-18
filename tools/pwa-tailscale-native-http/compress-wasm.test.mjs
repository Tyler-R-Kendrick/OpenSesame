import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  compressNativeWasm,
  compressorPin,
  verifyCompressedWasm,
} from "./compress-wasm.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

test("lossless validator checks the complete decoded WASM and original digest", () => {
  const gzip = gzipSync(raw);
  assert.equal(verifyCompressedWasm(gzip, raw, hash(raw)), gzip);
  assert.throws(() => verifyCompressedWasm(gzip, raw, "0".repeat(64)));
  assert.throws(() =>
    verifyCompressedWasm(gzip, Buffer.from("altered"), hash(raw)),
  );
  assert.throws(() =>
    verifyCompressedWasm(Buffer.from("invalid gzip"), raw, hash(raw)),
  );
  const invalid = Buffer.from("not WASM");
  assert.throws(() =>
    verifyCompressedWasm(gzipSync(invalid), invalid, hash(invalid)),
  );
});

test("compressor pin selects the reviewed official source and bounded deterministic parameters", () => {
  assert.equal(
    compressorPin.archiveURL,
    "https://zlib.net/pigz/pigz-2.8.tar.gz",
  );
  assert.equal(compressorPin.version, "2.8");
  assert.deepEqual(compressorPin.arguments, [
    "-11",
    "-I",
    "3",
    "-p",
    "2",
    "-b",
    "1024",
    "-n",
    "-c",
  ]);
  assert.ok(Object.isFrozen(compressorPin));
});

test("an archive substitution fails before extraction or native execution and is retained", async () => {
  const output = await mkdtemp(join(tmpdir(), "native-compressor-rejection-"));
  try {
    const archivePath = join(output, "altered.tar.gz");
    const changed = Buffer.from("untrusted archive");
    await writeFile(archivePath, changed);
    await assert.rejects(
      compressNativeWasm({ raw, wasmSha256: hash(raw), output, archivePath }),
      /official pin/,
    );
    assert.deepEqual(
      await readFile(join(output, "compressor/pigz-2.8.tar.gz")),
      changed,
    );
    assert.deepEqual((await readdir(join(output, "compressor"))).sort(), [
      "pigz-2.8.tar.gz",
      "tmp",
    ]);
    assert.deepEqual(await readdir(join(output, "compressor/tmp")), []);
  } finally {
    await rm(output, { recursive: true });
  }
});
