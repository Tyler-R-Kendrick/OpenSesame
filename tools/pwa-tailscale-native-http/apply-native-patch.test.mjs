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
import { nativePatchCommand } from "./apply-native-patch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = "7275f792d406d3c386cc807937a45a4a7b699d42\n";
const after = "7ef7b403648ac3a9481a6e88e8b894eff50b0167\n";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, "tools");
  await cp(here, tools, { recursive: true });
  const source = join(root, "source");
  const bin = join(root, "bin");
  await mkdir(source);
  await mkdir(bin);
  await writeFile(join(source, "go.toolchain.rev"), before);
  const pins = JSON.parse(await readFile(join(tools, "source.json"), "utf8"));
  assert.equal(hash(before), pins.toolchainSelection.beforeRevisionSha256);
  assert.equal(hash(after), pins.toolchainSelection.afterRevisionSha256);
  return { root, tools, source, bin, pins, invocation: 0 };
}
function args(f, name = "native-toolchain.patch") {
  return [
    "--batch",
    "--forward",
    ...(name === "disable-logtail.patch" ? ["--fuzz=0"] : []),
    "-p1",
    "-i",
    join(f.tools, name),
  ];
}
async function run(f, name = "native-toolchain.patch", override = undefined) {
  const output = await open(
    join(f.root, `console-${f.invocation++}.log`),
    "wx",
    0o600,
  );
  const child = spawn(
    process.execPath,
    [join(f.tools, "apply-native-patch.mjs"), ...(override ?? args(f, name))],
    {
      cwd: f.source,
      env: { PATH: f.bin },
      stdio: ["ignore", output.fd, output.fd],
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await output.close();
  return code;
}
async function savePins(f) {
  // Only malformed/multi-file unit fixtures change metadata. Production callers
  // retain the complete reviewed source/patch/preimage/postimage pin graph.
  await writeFile(join(f.tools, "source.json"), `${JSON.stringify(f.pins)}\n`);
}
test(
  "real Node patch applies exact reviewed revision with no patch executable on PATH",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const missing = spawn("patch", args(f), {
      cwd: f.source,
      env: { PATH: f.bin },
      stdio: "ignore",
    });
    const error = await new Promise((resolve) =>
      missing.once("error", resolve),
    );
    assert.equal(error.code, "ENOENT");
    assert.equal(await run(f), 0);
    assert.equal(
      await readFile(join(f.source, "go.toolchain.rev"), "utf8"),
      after,
    );
    assert.notEqual(await run(f), 0); // Forward-only: never treat an already applied patch as success.
  },
);
test("all reviewed patch invocations select the same Node helper; compiler commands stay original", () => {
  for (const name of [
    "native-toolchain.patch",
    "native-node.patch",
    "disable-logtail.patch",
    "native-peer-get.patch",
    "exit-route.patch",
    "native-ssh.patch",
  ]) {
    const original = ["--batch", "--forward", "-p1", "-i", join(here, name)];
    const result = nativePatchCommand("patch", original);
    assert.equal(result.program, process.execPath);
    assert.deepEqual(result.args, [
      join(here, "apply-native-patch.mjs"),
      ...original,
    ]);
    assert.deepEqual(original, [
      "--batch",
      "--forward",
      "-p1",
      "-i",
      join(here, name),
    ]);
  }
  const original = ["run", "probe.go"];
  assert.deepEqual(nativePatchCommand("/owned/compiler/bin/go", original), {
    program: "/owned/compiler/bin/go",
    args: original,
  });
});

test("SSH patch requires its exact target, digest, preimage and postimage", async (t) => {
  const f = await fixture(t);
  const path = "cmd/tsconnect/wasm/wasm_js.go";
  const original = "original SSH predecessor\n";
  const result = "verified SSH successor\n";
  const patch = `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${original}+${result}`;
  await mkdir(dirname(join(f.source, path)), { recursive: true });
  for (const mode of ["digest", "preimage", "postimage", "target"]) {
    const input =
      mode === "target"
        ? patch.replaceAll(path, "cmd/tsconnect/wasm/other_js.go")
        : patch;
    const bytes = mode === "preimage" ? "stale\n" : original;
    f.pins.nativeSSH.patch = {
      ...f.pins.nativeSSH.patch,
      sha256: mode === "digest" ? "0".repeat(64) : hash(input),
      beforeSha256: hash(original),
      afterSha256: mode === "postimage" ? "0".repeat(64) : hash(result),
    };
    await savePins(f);
    await writeFile(join(f.tools, "native-ssh.patch"), input);
    await writeFile(join(f.source, path), bytes);
    assert.notEqual(await run(f, "native-ssh.patch"), 0);
    assert.equal(await readFile(join(f.source, path), "utf8"), bytes);
  }
  f.pins.nativeSSH.patch = {
    ...f.pins.nativeSSH.patch,
    sha256: hash(patch),
    beforeSha256: hash(original),
    afterSha256: hash(result),
  };
  await savePins(f);
  await writeFile(join(f.tools, "native-ssh.patch"), patch);
  await writeFile(join(f.source, path), original);
  assert.equal(await run(f, "native-ssh.patch"), 0);
  assert.equal(await readFile(join(f.source, path), "utf8"), result);
  assert.notEqual(await run(f, "native-ssh.patch"), 0);
});
test(
  "stale preimage and wrong postimage refuse without target writes",
  { timeout: 10000 },
  async (t) => {
    for (const mode of ["stale", "postimage"]) {
      const f = await fixture(t);
      const original = mode === "stale" ? "unreviewed revision\n" : before;
      await writeFile(join(f.source, "go.toolchain.rev"), original);
      if (mode === "postimage") {
        f.pins.toolchainSelection.afterRevisionSha256 = "0".repeat(64);
        await savePins(f);
      }
      assert.notEqual(await run(f), 0);
      assert.equal(
        await readFile(join(f.source, "go.toolchain.rev"), "utf8"),
        original,
      );
    }
  },
);
test(
  "untrusted patch bytes are rejected by the original patch digest",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.tools, "native-toolchain.patch"),
      "not a reviewed patch\n",
    );
    assert.notEqual(await run(f), 0);
    assert.equal(
      await readFile(join(f.source, "go.toolchain.rev"), "utf8"),
      before,
    );
  },
);
test(
  "malformed counts, shifted context and unreviewed target paths fail even in explicitly repinned parser fixtures",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const original = await readFile(
      join(f.tools, "native-toolchain.patch"),
      "utf8",
    );
    for (const patch of [
      original.replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
      original.replace("@@ -1 +1 @@", "@@ -2 +2 @@"),
      original.replaceAll("go.toolchain.rev", "../escape"),
      original.replace("-7275", "-8275"),
    ]) {
      f.pins.toolchainSelection.patchSha256 = hash(patch);
      await savePins(f);
      await writeFile(join(f.tools, "native-toolchain.patch"), patch);
      assert.notEqual(await run(f), 0);
      assert.equal(
        await readFile(join(f.source, "go.toolchain.rev"), "utf8"),
        before,
      );
    }
  },
);
test(
  "stale later targets cannot partially apply any earlier target",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const paths = [
      "cmd/tsconnect/wasm/wasm_js.go",
      "net/tsdial/tsdial.go",
      "ipn/ipnlocal/node_backend.go",
      "derp/derphttp/derphttp_client.go",
    ];
    const patch = paths
      .map((path) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
      .join("");
    f.pins.nativeNode.files[1].sha256 = hash(patch);
    f.pins.nativeNode.patchTargets = paths.map((path) => ({
      path,
      beforeSha256: hash("old\n"),
      afterSha256: hash("new\n"),
    }));
    await savePins(f);
    await writeFile(join(f.tools, "native-node.patch"), patch);
    for (const path of paths) {
      await mkdir(dirname(join(f.source, path)), { recursive: true });
      await writeFile(join(f.source, path), "old\n");
    }
    for (const stale of paths.slice(1)) {
      await writeFile(join(f.source, stale), "stale\n");
      assert.notEqual(await run(f, "native-node.patch"), 0);
      for (const path of paths)
        assert.equal(
          await readFile(join(f.source, path), "utf8"),
          path === stale ? "stale\n" : "old\n",
        );
      await writeFile(join(f.source, stale), "old\n");
    }
    assert.equal(await run(f, "native-node.patch"), 0);
    for (const path of paths)
      assert.equal(await readFile(join(f.source, path), "utf8"), "new\n");
  },
);
test(
  "the actual zero-context exit-route insertion is exact and repeatable on owned line fixtures",
  { timeout: 10000 },
  async (t) => {
    const expected = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const f = await fixture(t);
      const path = "cmd/tsconnect/wasmbuild/wasmbuild.go";
      const original = `${Array.from({ length: 71 }, (_, index) => `line-${index}`).join("\n")}\n`;
      const lines = original.trimEnd().split("\n");
      lines.splice(
        69,
        0,
        '\t"useexitnode", // private compilation probe: existing exit-node routing',
      );
      const result = `${lines.join("\n")}\n`;
      f.pins.patch.beforeSha256 = hash(original);
      f.pins.patch.afterSha256 = hash(result);
      await savePins(f);
      await mkdir(dirname(join(f.source, path)), { recursive: true });
      await writeFile(join(f.source, path), original);
      assert.equal(await run(f, "exit-route.patch"), 0);
      expected.push(hash(await readFile(join(f.source, path))));
      assert.equal(expected.at(-1), hash(result));
    }
    assert.equal(expected[0], expected[1]);
  },
);
test(
  "symlinks and arbitrary invocation flags are refused",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await rm(join(f.source, "go.toolchain.rev"));
    await writeFile(join(f.root, "outside"), before);
    await symlink(join(f.root, "outside"), join(f.source, "go.toolchain.rev"));
    assert.notEqual(await run(f), 0);
    assert.equal(await readFile(join(f.root, "outside"), "utf8"), before);
    assert.notEqual(
      await run(f, "native-toolchain.patch", [...args(f), "--unsafe"]),
      0,
    );
  },
);

test("peer patch requires its exact target, digest, preimage, postimage and flags", async (t) => {
  const f = await fixture(t);
  const path = "cmd/tsconnect/wasm/wasm_js.go";
  const original = "owned peer predecessor\n";
  const result = "owned peer successor\n";
  const patch = `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${original}+${result}`;
  const pin = {
    ...f.pins.peerGET.patch,
    sha256: hash(patch),
    beforeSha256: hash(original),
    afterSha256: hash(result),
  };
  await mkdir(dirname(join(f.source, path)), { recursive: true });
  for (const mode of ["digest", "preimage", "postimage", "target", "flags"]) {
    const bytes = mode === "preimage" ? "stale peer predecessor\n" : original;
    const input =
      mode === "target"
        ? patch.replaceAll(path, "cmd/tsconnect/wasm/other_js.go")
        : patch;
    f.pins.peerGET.patch = {
      ...pin,
      sha256: mode === "digest" ? "0".repeat(64) : hash(input),
      afterSha256: mode === "postimage" ? "0".repeat(64) : pin.afterSha256,
    };
    await savePins(f);
    await writeFile(join(f.tools, "native-peer-get.patch"), input);
    await writeFile(join(f.source, path), bytes);
    const override =
      mode === "flags"
        ? [...args(f, "native-peer-get.patch"), "--unsafe"]
        : undefined;
    assert.notEqual(await run(f, "native-peer-get.patch", override), 0);
    assert.equal(await readFile(join(f.source, path), "utf8"), bytes);
  }
  f.pins.peerGET.patch = pin;
  await savePins(f);
  await writeFile(join(f.tools, "native-peer-get.patch"), patch);
  await writeFile(join(f.source, path), original);
  assert.equal(await run(f, "native-peer-get.patch"), 0);
  assert.equal(await readFile(join(f.source, path), "utf8"), result);
  assert.notEqual(await run(f, "native-peer-get.patch"), 0);
  assert.equal(await readFile(join(f.source, path), "utf8"), result);
});
