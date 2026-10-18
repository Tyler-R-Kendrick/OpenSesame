import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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

test("explicit archive paths reject symlinks and directories before native execution", async () => {
  const output = await mkdtemp(join(tmpdir(), "native-compressor-path-"));
  try {
    const target = join(output, "target");
    await writeFile(target, "untrusted");
    const link = join(output, "link");
    await symlink(target, link);
    for (const [name, archivePath] of [
      ["link-case", link],
      ["directory-case", output],
    ]) {
      const owned = join(output, name);
      await mkdir(owned);
      await assert.rejects(
        compressNativeWasm({
          raw,
          wasmSha256: hash(raw),
          output: owned,
          archivePath,
        }),
      );
      assert.deepEqual((await readdir(join(owned, "compressor"))).sort(), [
        "tmp",
      ]);
    }
  } finally {
    await rm(output, { recursive: true });
  }
});

test("default stages the exact local archive without curl before extraction", async () => {
  const output = await mkdtemp(join(tmpdir(), "native-compressor-local-"));
  try {
    const bin = join(output, "bin");
    await mkdir(bin);
    for (const name of ["tar", "curl"]) {
      const executable = join(bin, name);
      await writeFile(
        executable,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(output, `${name}.called`))}, "yes");process.exit(77);\n`,
      );
      await chmod(executable, 0o700);
    }
    const script = join(output, "exercise.mjs");
    await writeFile(
      script,
      `import assert from "node:assert/strict";
import { compressNativeWasm } from ${JSON.stringify(new URL("./compress-wasm.mjs", import.meta.url).href)};
await assert.rejects(compressNativeWasm({raw:Buffer.from([0,97,115,109,1,0,0,0]),wasmSha256:${JSON.stringify(hash(raw))},output:${JSON.stringify(output)}}), /Pinned native compressor command failed/);
`,
    );
    await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 15_000,
      maxBuffer: 1_048_576,
    });
    assert.equal(await readFile(join(output, "tar.called"), "utf8"), "yes");
    await assert.rejects(readFile(join(output, "curl.called")), {
      code: "ENOENT",
    });
    const staged = await readFile(join(output, "compressor/pigz-2.8.tar.gz"));
    assert.equal(staged.length, 121304);
    assert.equal(hash(staged), compressorPin.archiveSha256);
    assert.deepEqual((await readdir(join(output, "compressor"))).sort(), [
      "pigz-2.8.tar.gz",
      "tmp",
    ]);
  } finally {
    await rm(output, { recursive: true });
  }
});
