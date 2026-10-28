import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { nativePatchCommand } from "./apply-native-patch.mjs";
import { composeNative, nativeBuildEnvironment } from "./compose-native.mjs";
import { emitNativeAssets } from "./native-assets.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
function required(name) {
  assert.ok(process.env[name], `Pass verified ${name}; no fixture fallback.`);
  return resolve(process.env[name]);
}
const original = required("PWA_NATIVE_HTTP_SOURCE");
const compiler = required("PWA_NATIVE_HTTP_COMPILER");
const wasm = required("PWA_NATIVE_HTTP_WASM");
const repositoryRoot = required("PWA_NATIVE_HTTP_REPOSITORY");
const area = await mkdtemp(join(tmpdir(), "opensesame-native-composition-"));
after(() => rm(area, { recursive: true, force: true }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function requireHash(path, expected) {
  assert.equal(hash(await readFile(path)), expected, "Pinned source changed.");
}
async function fixture() {
  const directory = await mkdtemp(join(area, "case-"));
  const source = join(directory, "source");
  const output = join(directory, "output");
  await mkdir(source);
  await mkdir(output);
  for (const name of [
    "go.mod",
    "go.sum",
    "go.toolchain.rev",
    "assert_ts_toolchain_match.go",
    "LICENSE",
    "cmd/tsconnect/wasm/wasm_js.go",
    "net/tsdial/tsdial.go",
    "net/tlsdial/tlsdial.go",
    "ipn/ipnlocal/node_backend.go",
    "licenses/tailscale.md",
  ]) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await copyFile(join(original, name), join(source, name));
  }
  await mkdir(join(source, "cmd/tsconnect/nativehttp"));
  for (const file of pins.nativeHttp.files) {
    await requireHash(join(here, file.path), file.sha256);
    await copyFile(
      join(here, file.path),
      join(source, "cmd/tsconnect/nativehttp", file.path),
    );
  }
  const commands = [];
  return {
    here,
    source,
    output,
    pins: structuredClone(pins),
    requireHash,
    commands,
    execute: async (program, args, name, verify) => {
      await verify();
      const command = nativePatchCommand(program, args);
      const child = spawn(command.program, command.args, {
        cwd: source,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
        timeout: 5000,
        stdio: "ignore",
      });
      const result = await new Promise((resolve) => {
        let error;
        child.once("error", (value) => {
          error = value;
        });
        child.once("close", (status) => resolve({ error, status }));
      });
      commands.push({ name, status: result.status });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${name} failed.`);
      await verify();
    },
  };
}

test("fixed composition patches actual source while preserving original manifest/assertion bytes", async () => {
  const scope = await fixture();
  const selected = await composeNative(scope);
  assert.equal(
    selected.flags,
    `-p=2 -buildvcs=false -mod=readonly -modfile=${scope.output}/native.mod`,
  );
  assert.deepEqual(scope.commands, [
    { name: "select-native-toolchain", status: 0 },
    { name: "native-node-patch", status: 0 },
    { name: "disable-remote-logtail", status: 0 },
    { name: "native-peer-get-patch", status: 0 },
    { name: "native-ssh-patch", status: 0 },
  ]);
  await selected.verify();
  const dnsPath = join(scope.source, "ipn/ipnlocal/native-extra-dns.go");
  const dnsBytes = await readFile(dnsPath);
  assert.equal(
    hash(dnsBytes),
    pins.nativeNode.files.find((file) => file.path === "native-extra-dns.go")
      .sha256,
  );
  await writeFile(dnsPath, "changed");
  await assert.rejects(selected.verify(), /Pinned source changed/);
  await writeFile(dnsPath, dnsBytes);
  for (const name of ["go.mod", "go.sum", "assert_ts_toolchain_match.go"])
    assert.deepEqual(
      await readFile(join(scope.source, name)),
      await readFile(join(original, name)),
    );
  const names = await readdir(join(scope.source, "cmd/tsconnect/nativehttp"));
  assert.deepEqual(
    names.sort(),
    [
      ...pins.nativeHttp.files.map((file) => file.path),
      ...pins.peerGET.files
        .filter((file) => !file.path.startsWith("nodepeerget"))
        .map((file) => file.path),
      "nativehttp_js.go",
      "streaming_js.go",
      "public-roots.go",
      "public-roots_test.go",
    ].sort(),
  );
  await writeFile(join(scope.output, "native.sum"), "changed");
  await assert.rejects(selected.verify(), /Pinned source changed/);
});

test("pull bridge staging fixes paths, verifies bytes and preserves occupied destinations", async () => {
  const wrongPath = await fixture();
  wrongPath.pins.nativeBridge.files[3].path = "../streaming_js.go";
  await assert.rejects(composeNative(wrongPath), /fixed scope/);
  const wrongBytes = await fixture();
  wrongBytes.pins.nativeBridge.files[3].sha256 = "0".repeat(64);
  await assert.rejects(composeNative(wrongBytes), /Pinned source changed/);
  const occupied = await fixture();
  const destination = join(
    occupied.source,
    "cmd/tsconnect/nativehttp/streaming_js.go",
  );
  await writeFile(destination, "preserved sentinel");
  await assert.rejects(composeNative(occupied), { code: "EEXIST" });
  assert.equal(await readFile(destination, "utf8"), "preserved sentinel");
  const staged = await fixture();
  const selected = await composeNative(staged);
  const target = join(
    staged.source,
    "cmd/tsconnect/nativehttp/streaming_js.go",
  );
  assert.equal(hash(await readFile(target)), pins.nativeBridge.files[3].sha256);
  await writeFile(target, "changed pull bridge");
  await assert.rejects(selected.verify(), /Pinned source changed/);
});

test("root overlay paths cannot become an arbitrary staging loader", async () => {
  const scope = await fixture();
  scope.pins.publicTrust.files[0].path = "../escape.go";
  await assert.rejects(composeNative(scope), /two fixed/);
  assert.deepEqual(
    (await readdir(join(scope.source, "cmd/tsconnect/nativehttp"))).sort(),
    pins.nativeHttp.files.map((file) => file.path).sort(),
  );
});

test("wrong root bytes and a pre-existing root destination fail closed", async () => {
  const changed = await fixture();
  changed.pins.publicTrust.files[0].sha256 = "0".repeat(64);
  await assert.rejects(composeNative(changed), /Pinned source changed/);
  const occupied = await fixture();
  const path = join(
    occupied.source,
    "cmd/tsconnect/nativehttp/public-roots.go",
  );
  await writeFile(path, "sentinel");
  await assert.rejects(composeNative(occupied), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "sentinel");
});

test("child environment retains proxy/CA policy without unrelated credentials or toolchain overrides", () => {
  const env = nativeBuildEnvironment("/owned", "-mod=readonly", {
    PATH: "/bin",
    HTTPS_PROXY: "http://proxy",
    SSL_CERT_FILE: "/ca",
    HOME: "/private",
    TOKEN: "not-inherited",
    TS_PERMIT_TOOLCHAIN_MISMATCH: "1",
    GOFLAGS: "-tags=not-approved",
    GOWORK: "/ambient",
  });
  assert.equal(env.HTTPS_PROXY, "http://proxy");
  assert.equal(env.SSL_CERT_FILE, "/ca");
  assert.equal(env.GOFLAGS, "-mod=readonly");
  assert.equal(env.GOWORK, "off");
  for (const key of ["HOME", "TOKEN", "TS_PERMIT_TOOLCHAIN_MISMATCH"])
    assert.equal(env[key], undefined);
});

async function assets(options = {}) {
  const scope = await fixture();
  return {
    ...scope,
    compiler,
    repositoryRoot,
    wasm,
    wasmSha256: hash(await readFile(wasm)),
    ...options,
  };
}

test("real compiled WASM, compiler shim and bundled bridge emit exact hash-named assets/notices", async () => {
  const scope = await assets();
  const result = await emitNativeAssets(scope);
  const read = (asset) => readFile(join(scope.output, asset.path));
  assert.deepEqual(
    gunzipSync(await read(result.assets.wasm)),
    await readFile(wasm),
  );
  assert.equal(
    hash(await readFile(join(compiler, "lib/wasm/wasm_exec.js"))),
    scope.pins.composition.runtimeSha256,
  );
  assert.equal(
    hash(await read(result.assets.runtime)),
    scope.pins.composition.runtimeMinifiedSha256,
  );
  assert.equal(
    hash(await read(result.assets.nativeHTTP)),
    scope.pins.composition.bridgeSha256,
  );
  for (const asset of [
    ...Object.values(result.assets),
    result.license,
    result.upstreamNotices,
  ]) {
    const bytes = await read(asset);
    assert.equal(bytes.length, asset.bytes);
    assert.equal(hash(bytes), asset.sha256);
  }
  const bridge = await import(
    `file://${join(scope.output, result.assets.nativeHTTP.path)}`
  );
  assert.throws(() => bridge.bindNativeHTTP({}, {}), {
    message: "Invalid native HTTPS request.",
  });
  const notice = (await read(result.license)).toString();
  for (const path of [
    join(scope.source, "LICENSE"),
    join(compiler, "LICENSE"),
    join(repositoryRoot, "node_modules/zod/LICENSE"),
  ])
    assert.ok(notice.includes(await readFile(path, "utf8")));
  assert.deepEqual(
    await read(result.upstreamNotices),
    await readFile(join(scope.source, "licenses/tailscale.md")),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(scope.output, "native-artifacts.json"), "utf8"),
    ),
    result,
  );
  await assert.rejects(emitNativeAssets(scope), { code: "EEXIST" });
});

test("changed compiler shim/WASM/dependency/license/notice never produces an asset manifest", async () => {
  for (const mutation of [
    "runtime",
    "wasm",
    "zod",
    "vite",
    "graph",
    "license",
    "notices",
  ]) {
    const scope = await assets();
    if (mutation === "runtime") scope.pins.composition.runtimeSha256 = "wrong";
    if (mutation === "wasm") scope.wasmSha256 = "wrong";
    if (mutation === "zod") scope.pins.composition.zod.packageSha256 = "wrong";
    if (mutation === "vite")
      scope.pins.composition.vite.packageSha256 = "wrong";
    if (mutation === "graph") scope.pins.composition.bridgeSha256 = "wrong";
    if (mutation === "license") scope.pins.compiler.licenseSha256 = "wrong";
    if (mutation === "notices")
      scope.pins.composition.thirdPartySha256 = "wrong";
    await assert.rejects(emitNativeAssets(scope));
    await assert.rejects(
      readFile(join(scope.output, "native-artifacts.json")),
      { code: "ENOENT" },
    );
  }
});

test("returned composition verifier retains all staged peer byte ownership", async () => {
  const scope = await fixture();
  const selected = await composeNative(scope);
  for (const file of pins.peerGET.files) {
    const target = join(
      scope.source,
      "cmd/tsconnect",
      file.path.startsWith("nodepeerget") ? "wasm" : "nativehttp",
      file.path,
    );
    const originalBytes = await readFile(target);
    await writeFile(target, "changed peer source");
    await assert.rejects(selected.verify(), /Pinned source changed/);
    await writeFile(target, originalBytes);
    await selected.verify();
  }
});
