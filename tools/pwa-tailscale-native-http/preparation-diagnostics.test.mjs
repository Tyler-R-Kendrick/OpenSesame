import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describePreparationFailure } from "./preparation-diagnostics.mjs";
import { nativePreparationCommand } from "./prepare-distribution.mjs";

const originalState = { reason: "exit", exitCode: 7, signal: null };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-preparation-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(
    root,
    ".cache/pwa-tailscale-native-http/work",
    randomUUID(),
  );
  await mkdir(join(work, "build/logs"), { recursive: true });
  return { root, work, log: join(work, "build.log") };
}
async function receipt(f, phase = "native-build") {
  const path = join(f.work, `native-preparation-${phase}-failure.json`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 1_048_576);
  return JSON.parse(bytes);
}
async function fail(f, script, timeout = 2000) {
  let caught;
  try {
    await nativePreparationCommand(
      "/bin/sh",
      ["-c", script],
      f.log,
      f.work,
      timeout,
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.ok(Buffer.byteLength(caught.message) <= 16_384);
  assert.ok(Buffer.byteLength(caught.stack) <= 16_384);
  return caught;
}
async function ready(f) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    try {
      const body = await readFile(f.log, "utf8");
      if (body.startsWith("ready:")) return Number(body.split(":")[1].trim());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((accept) => setTimeout(accept, 10));
  }
  assert.fail("The owned real child did not announce readiness.");
}
function gone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("a real child exit records actual outer status and a useful redacted tail", async (t) => {
  const f = await fixture(t);
  const error = await fail(
    f,
    "printf 'compile failed: missing module\\nproxy=https://user:secret@proxy.example/\\n'; exit 7",
  );
  const record = await receipt(f);
  assert.equal(record.scope, "outer-preparation-command-only");
  assert.equal(record.innerCompilerExit, "unknown");
  assert.equal(record.phase, "native-build");
  assert.equal(record.reason, "exit");
  assert.equal(record.exitCode, 7);
  assert.equal(record.signal, null);
  assert.match(error.message, /compile failed: missing module/);
  assert.doesNotMatch(JSON.stringify(record) + error.stack, /user:secret/);
});

test("an actual signal exit and missing executable retain their distinct outcomes", async (t) => {
  const f = await fixture(t);
  await fail(f, "kill -TERM $$");
  const killed = await receipt(f);
  assert.equal(killed.reason, "exit");
  assert.equal(killed.exitCode, null);
  assert.equal(killed.signal, "SIGTERM");
  const log = join(f.work, "source-download.log");
  await assert.rejects(
    nativePreparationCommand(
      join(f.root, "missing-executable"),
      [],
      log,
      f.work,
      2000,
    ),
    (error) => {
      assert.equal(error.code, "ENOENT");
      assert.match(error.message, /outer command only/);
      return true;
    },
  );
  const missing = await receipt(f, "source-download");
  assert.equal(missing.reason, "spawn");
  assert.equal(missing.spawnCode, "ENOENT");
  assert.equal(missing.exitCode, null);
});

test("the original deadline terminates the actual owned group and identifies timeout", async (t) => {
  const f = await fixture(t);
  const result = fail(f, "printf 'ready:%s\\n' $$; exec sleep 30", 150);
  const pid = await ready(f);
  await result;
  assert.equal((await receipt(f)).reason, "timeout");
  assert.equal((await receipt(f)).signal, "SIGTERM");
  gone(pid);
});

test("actual external SIGINT and SIGTERM retain cancellation and release handlers", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = await fixture(t);
    const before = process.listenerCount(signal);
    const result = fail(f, "printf 'ready:%s\\n' $$; exec sleep 30");
    const pid = await ready(f);
    process.kill(process.pid, signal);
    await result;
    assert.equal((await receipt(f)).reason, signal);
    assert.equal(process.listenerCount(signal), before);
    gone(pid);
  }
});

test("the unchanged resource monitor stops a real child on oversized sparse owned storage", async (t) => {
  const f = await fixture(t);
  const result = fail(f, "printf 'ready:%s\\n' $$; exec sleep 30", 4000);
  const pid = await ready(f);
  const sparse = await open(join(f.work, "sparse-resource-fixture"), "wx");
  try {
    // Existing resource accounting counts logical sparse bytes, not allocated disk.
    await sparse.truncate(27 * 1024 ** 3 + 1);
    await result;
    assert.equal((await receipt(f)).reason, "resource");
    gone(pid);
  } finally {
    await sparse.close();
  }
});

test("successful actual commands produce no failure receipt", async (t) => {
  const f = await fixture(t);
  await nativePreparationCommand(
    "/bin/sh",
    ["-c", "printf 'success\\n'"],
    f.log,
    f.work,
    2000,
  );
  assert.deepEqual((await readdir(f.work)).sort(), ["build", "build.log"]);
});

test("same Error identity, code and cause survive redaction and receipt write refusal", async (t) => {
  const f = await fixture(t);
  const cause = new Error("original cause");
  const error = Object.assign(
    new Error("Authorization: Bearer example-secret", { cause }),
    { code: "EACCES" },
  );
  const original = error;
  const path = join(f.work, "native-preparation-native-build-failure.json");
  await writeFile(path, "do not replace");
  await writeFile(f.log, "useful diagnostic\n");
  await describePreparationFailure(error, f.work, f.log, originalState);
  assert.equal(error, original);
  assert.equal(error.code, "EACCES");
  assert.equal(error.cause, cause);
  assert.equal(await readFile(path, "utf8"), "do not replace");
  assert.doesNotMatch(error.stack + error.message, /example-secret/);
  assert.match(error.message, /useful diagnostic/);
});

test("only fixed current-work logs are read; symlink, hardlink and unknown files are refused", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.log");
  await writeFile(outside, "OUTSIDE-CONFIDENTIAL\n");
  await symlink(outside, f.log);
  await link(outside, join(f.work, "build/logs/baseline.log"));
  await writeFile(
    join(f.work, "build/logs/unknown.log"),
    "UNKNOWN-CONFIDENTIAL\n",
  );
  await writeFile(
    join(f.work, "build/logs/baseline-repeat.log"),
    "trusted compile failure\n",
  );
  await writeFile(join(f.work, ".env"), "ENV-CONFIDENTIAL\n");
  const error = new Error("failed");
  await describePreparationFailure(error, f.work, f.log, originalState);
  const record = await receipt(f);
  assert.deepEqual(
    record.logs.map((entry) => entry.name),
    ["build/logs/baseline-repeat.log"],
  );
  assert.doesNotMatch(JSON.stringify(record) + error.message, /CONFIDENTIAL/);
});

test("symlinked directory ancestors and escaped work/log paths leave the error untouched", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.root, alias);
  const linked = f.work.replace(f.root, alias);
  const paths = [
    [linked, join(linked, "build.log")],
    [f.work, join(f.work, "..", "build.log")],
    [join(f.work, ".."), f.log],
    [f.work, join(f.work, "unlisted.log")],
  ];
  for (const [work, log] of paths) {
    const error = new Error("unchanged");
    await describePreparationFailure(error, work, log, originalState);
    assert.equal(error.message, "unchanged");
  }
  assert.deepEqual(await readdir(f.work), ["build"]);
});

test("private receipts and emitted context stay bounded after JSON expansion and multibyte text", async (t) => {
  const f = await fixture(t);
  const text = `${"\u0001😀 harmless\n".repeat(35_000)}final diagnostic\n`;
  for (const name of [
    "build.log",
    "build/logs/baseline.log",
    "build/logs/baseline-repeat.log",
    "build/logs/exit-feature.log",
    "build/logs/exit-feature-repeat.log",
  ])
    await writeFile(join(f.work, name), text);
  const error = new Error("operator error");
  await describePreparationFailure(error, f.work, f.log, originalState);
  const record = await receipt(f);
  assert.ok(record.logs.length > 0);
  assert.match(error.message, /final diagnostic/);
  assert.ok(Buffer.byteLength(error.message) <= 16_384);
  assert.ok(Buffer.byteLength(error.stack) <= 16_384);
});

test("labelled credentials, headers, URL secrets, JWT and truncated private keys are redacted", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.log,
    [
      "compile failed",
      "https://user:url-secret@proxy.example/?token=query-secret",
      "Cookie: cookie-secret",
      "client_secret=assignment-secret",
      "Authorization: Basic basic-secret",
      "Bearer standalone-secret",
      "eyJheader.eyJpayload.signature",
      "ghp_12345678901234567890",
      "-----BEGIN PRIVATE KEY-----",
      "pem-secret",
    ].join("\n"),
  );
  const error = new Error("failed");
  await describePreparationFailure(error, f.work, f.log, originalState);
  const output = JSON.stringify(await receipt(f)) + error.stack;
  for (const secret of [
    "url-secret",
    "query-secret",
    "cookie-secret",
    "assignment-secret",
    "basic-secret",
    "standalone-secret",
    "eyJheader",
    "ghp_123",
    "pem-secret",
  ])
    assert.ok(!output.includes(secret), secret);
  assert.match(output, /compile failed/);
});

test("unwritable or unsafe receipt targets and frozen errors never replace the initiating failure", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.json");
  await writeFile(outside, "unchanged");
  await symlink(
    outside,
    join(f.work, "native-preparation-native-build-failure.json"),
  );
  await writeFile(f.log, "useful log\n");
  const error = Object.freeze(new Error("original frozen failure"));
  await describePreparationFailure(error, f.work, f.log, originalState);
  assert.equal(error.message, "original frozen failure");
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});
