import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { browserCertStaticHandler } from "./browser-cert-static.mjs";
import { fileSteps } from "./capture-file-steps.mjs";
import {
  privateSharedTempDir,
  privateTempDir,
  writePrivateSnapshot,
} from "./private-files.mjs";

const dirs = [];
function scratch() {
  const dir = privateTempDir("opensesame-tools-test-");
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("private developer-tool files", () => {
  it("allows capture/compose reuse only inside an owned private root", () => {
    const root = scratch();
    assert.equal(privateSharedTempDir(basename(root)), root);
    assert.equal(privateSharedTempDir(basename(root)), root);
    chmodSync(root, 0o755);
    assert.throws(() => privateSharedTempDir(basename(root)));
    chmodSync(root, 0o700);
    const link = scratch();
    rmSync(link, { recursive: true });
    symlinkSync(root, link);
    assert.throws(() => privateSharedTempDir(basename(link)));
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });

  it("allocates private independent namespaces", () => {
    const a = scratch();
    const b = scratch();
    assert.notEqual(a, b);
    assert.equal(statSync(a).mode & 0o777, 0o700);
  });
  it("preserves the snapshot contract and rejects planted symlinks, hardlinks and public files", () => {
    const dir = scratch();
    const sentinel = join(dir, "sentinel");
    writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    const file = join(dir, "snapshot");
    symlinkSync(sentinel, file);
    assert.throws(() => writePrivateSnapshot(file, "attack"));
    rmSync(file);
    linkSync(sentinel, file);
    assert.throws(() => writePrivateSnapshot(file, "attack"));
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
    rmSync(file);
    writeFileSync(file, "public", { mode: 0o644 });
    chmodSync(file, 0o644);
    assert.throws(() => writePrivateSnapshot(file, "attack"));
    assert.equal(readFileSync(file, "utf8"), "public");
    rmSync(file);
    writePrivateSnapshot(file, "long snapshot");
    writePrivateSnapshot(file, "new");
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
  it("creates capture inputs privately, cleans them, and rejects names escaping the directory", async () => {
    let captured;
    const input = {
      count: async () => 1,
      setInputFiles: async (file) => {
        captured = file;
        assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
        assert.equal(readFileSync(file).length, 16);
      },
    };
    const page = {
      getByLabel: () => ({ first: () => input }),
      waitForTimeout: async () => {},
    };
    const { setFile } = fileSteps({ press: async () => {} });
    await setFile(page, { label: "File", name: "fixture.json", bytes: 16 });
    assert.equal(existsSync(captured), false);
    for (const name of ["../sentinel", "/tmp/sentinel", "..", "a\\b"])
      await assert.rejects(setFile(page, { label: "File", name, bytes: 16 }));
  });
});

it("serves real assets and SPA routes while refusing raw HTTP traversal and symlink escapes", async () => {
  const dir = scratch();
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "app");
  writeFileSync(join(dist, "asset.js"), "asset");
  writeFileSync(join(dir, "package.json"), "outside sentinel");
  symlinkSync(join(dir, "package.json"), join(dist, "link.json"));
  const server = createServer(browserCertStaticHandler(dist));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const get = (path) =>
    new Promise((resolve, reject) => {
      request(
        { hostname: "127.0.0.1", port: server.address().port, path },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      )
        .on("error", reject)
        .end();
    });
  try {
    for (const path of [
      "/../../package.json",
      "/OpenSesame/../package.json",
      "/%2e%2e/package.json",
      "/OpenSesame/%2e%2e%2fpackage.json",
      "/link.json",
      "/%00.json",
      "/%zz",
      "/..%5cpackage.json",
    ])
      assert.deepEqual(await get(path), { status: 404, body: "not found" });
    assert.deepEqual(await get("/OpenSesame/asset.js?x=1"), {
      status: 200,
      body: "asset",
    });
    assert.deepEqual(await get("/OpenSesame/vault"), {
      status: 200,
      body: "app",
    });
    assert.equal((await get("/__cors-probe")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
