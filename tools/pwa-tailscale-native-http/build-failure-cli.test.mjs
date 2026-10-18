import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeBuildEnvironment } from "./compose-native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-build-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, "tools/pwa-tailscale-native-http");
  await cp(here, tools, { recursive: true });
  // Exact production JS; only owned archive pins below are unit fixtures.
  // The child stops before extracting a source tree or invoking any compiler.
  await symlink(
    join(here, "../../node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  const source = join(root, "source.fixture");
  const compiler = join(root, "compiler.fixture");
  await writeFile(source, "source archive fixture");
  await writeFile(compiler, "compiler archive fixture");
  await writeFile(
    join(tools, "source.json"),
    JSON.stringify({
      source: {
        archiveSha256: hash(await readFile(source)),
        criticalFiles: [],
      },
      compiler: {
        archiveSha256: hash(await readFile(compiler)),
        criticalFiles: [],
      },
    }),
  );
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "tmp"));
  return { root, tools, source, compiler, bin, output: join(root, "output") };
}
async function run(f) {
  const logPath = join(f.root, "console.log");
  const log = await open(logPath, "wx", 0o600);
  const child = spawn(
    process.execPath,
    [join(f.tools, "build.mjs"), f.source, f.compiler, f.output],
    {
      env: nativeBuildEnvironment(f.root, "", { ...process.env, PATH: f.bin }),
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await log.close();
  const text = await readFile(logPath, "utf8");
  assert.equal(exit, 1);
  const lines = text.split("\n");
  const index = lines.indexOf(
    "Native build driver diagnostics (not a compiler proof):",
  );
  assert.ok(index >= 0, text);
  return { text, record: JSON.parse(lines[index + 1]) };
}
test(
  "actual builder reports missing tar ENOENT before any compiler",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const { text, record } = await run(f);
    t.diagnostic(JSON.stringify(record));
    assert.equal(record.stage, "extract-source");
    assert.equal(record.lastCommand.reason, "spawn");
    assert.equal(record.lastCommand.spawnCode, "ENOENT");
    assert.equal(record.lastCommand.exitCode, null);
    assert.equal(record.errorCode, "ENOENT");
    assert.match(text, /spawn tar ENOENT/);
  },
);
test(
  "actual child exit survives a secondary archive verification failure",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    // This deliberately failing owned command corrupts only the fixture archive.
    // A changed after-check must not replace the original child failure.
    await writeFile(
      join(f.bin, "tar"),
      '#!/bin/sh\nprintf x >> "$2"\nexit 17\n',
      { mode: 0o700 },
    );
    const { text, record } = await run(f);
    t.diagnostic(JSON.stringify(record));
    assert.equal(record.stage, "extract-source");
    assert.equal(record.lastCommand.reason, "exit");
    assert.equal(record.lastCommand.exitCode, 17);
    assert.equal(record.lastCommand.signal, null);
    assert.match(text, /extract-source failed or was interrupted/);
    assert.doesNotMatch(text, /Error: Pinned input digest differs/);
  },
);
test(
  "actual fresh-output refusal reports its original error without a child exit",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(f.output);
    await writeFile(join(f.output, "owned-sentinel"), "keep");
    const { text, record } = await run(f);
    t.diagnostic(JSON.stringify(record));
    assert.equal(record.stage, "fresh-output");
    assert.equal(record.lastCommand, null);
    assert.match(text, /Use a fresh output directory/);
    assert.equal(
      await readFile(join(f.output, "owned-sentinel"), "utf8"),
      "keep",
    );
  },
);
