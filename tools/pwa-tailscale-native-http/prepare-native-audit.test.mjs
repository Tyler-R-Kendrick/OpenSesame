import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
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
import { prepareNativeAudit } from "./prepare-distribution.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** An owned child fixture exercises preparation lifetime, not a genuine compiler or vulnerability scan. */
async function fixture(t, failure = false) {
  const root = await mkdtemp(join(tmpdir(), "native-audit-lifetime-"));
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "other task");
  await chmod(outside, 0o500);
  t.after(async () => {
    await chmod(outside, 0o700);
    try {
      for (const name of await readdir(join(root, "reports/native-go/work")))
        await chmod(
          join(
            root,
            "reports/native-go/work",
            name,
            "audit/cache/mod/read-only-module",
          ),
          0o700,
        ).catch(() => {});
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, "repository");
  const reports = join(root, "reports");
  const here = join(repository, "tools/pwa-tailscale-native-http");
  const archives = join(
    repository,
    ".cache/pwa-tailscale-native-http/archives",
  );
  await mkdir(here, { recursive: true });
  await mkdir(archives, { recursive: true });
  const builder = `import {chmod,mkdir,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const output=process.argv[4];
for(const name of ['source','compiler','cache','tmp','audit-tools']){
 await mkdir(join(output,name),{recursive:true});
 await writeFile(join(output,name,'large.fixture'),Buffer.alloc(131072,120));
}
const module=join(output,'cache','mod','read-only-module');
await mkdir(module,{recursive:true});
await writeFile(join(module,'dependency.go'),'fixture');
await chmod(join(module,'dependency.go'),0o444);await chmod(module,0o555);
await symlink(${JSON.stringify(outside)},join(output,'cache','external-link'),'dir');
await mkdir(join(output,'logs'));await writeFile(join(output,'logs','scanner.log'),'private diagnostic');
await writeFile(join(output,'native-package-graph.json'),'fixture package graph');
await writeFile(join(output,'native-vulnerability-scan.json'),'fixture scanner output');
await writeFile(join(output,'..','source.download'),'partial archive');
await writeFile(join(output,'..','compiler.download'),'partial archive');
console.log('owned builder diagnostic');
${failure ? `process.exitCode=${failure === "uncertain" ? 125 : 1};` : `await writeFile(join(output,'native-audit.json'),JSON.stringify({compilerVersion:'go1.27.3',affectedImportedPackages:0,packages:3,modules:3,moduleOnlyAdvisories:[]}));`}
`;
  await writeFile(join(here, "build.mjs"), builder);
  await writeFile(join(here, "exit-route.patch"), "fixture patch");
  const sourceArchive = Buffer.from("fixture source archive");
  const compilerArchive = Buffer.from("fixture compiler archive");
  for (const bytes of [sourceArchive, compilerArchive])
    await writeFile(join(archives, `${hash(bytes)}.tar.gz`), bytes);
  const pins = {
    source: {
      archiveURL: "https://example.invalid/source",
      archiveSha256: hash(sourceArchive),
    },
    compiler: {
      version: "go1.27.3",
      archiveURL: "https://example.invalid/compiler",
      archiveSha256: hash(compilerArchive),
    },
    nativeHttp: { files: [] },
    nativeBridge: { files: [] },
    nativeNode: {
      files: [],
      stagingHelper: { path: "build.mjs", sha256: hash(builder) },
    },
    toolchainSelection: { files: [] },
    privateLogging: { files: [] },
    publicTrust: { files: [] },
    composition: { files: [] },
    patch: { sha256: hash("fixture patch") },
  };
  const source = JSON.stringify(pins);
  await writeFile(join(here, "source.json"), source);
  const sibling = join(
    reports,
    "native-go/work/another-invocation/audit/source",
  );
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, "keep.txt"), "not this invocation");
  return {
    repository,
    reports,
    sourceSha: hash(source),
    archives,
    outside,
    sibling,
  };
}
async function retainedWorks(f) {
  const directory = join(f.reports, "native-go/work");
  return (await readdir(directory))
    .filter((name) => name !== "another-invocation")
    .map((name) => join(directory, name));
}
async function assertRetired(f, work, success) {
  for (const name of ["source", "compiler", "cache", "tmp", "audit-tools"])
    await assert.rejects(lstat(join(work, "audit", name)), { code: "ENOENT" });
  for (const name of ["tmp", "source.download", "compiler.download"])
    await assert.rejects(lstat(join(work, name)), { code: "ENOENT" });
  assert.match(
    await readFile(join(work, "audit.log"), "utf8"),
    /owned builder diagnostic/,
  );
  assert.equal(
    await readFile(join(work, "audit/logs/scanner.log"), "utf8"),
    "private diagnostic",
  );
  assert.equal(
    await readFile(join(work, "audit/native-package-graph.json"), "utf8"),
    "fixture package graph",
  );
  assert.equal(
    await readFile(join(work, "audit/native-vulnerability-scan.json"), "utf8"),
    "fixture scanner output",
  );
  if (success)
    assert.equal(
      JSON.parse(await readFile(join(work, "audit/native-audit.json")))
        .affectedImportedPackages,
      0,
    );
  else
    await assert.rejects(lstat(join(work, "audit/native-audit.json")), {
      code: "ENOENT",
    });
  assert.equal(
    await readFile(join(f.outside, "keep.txt"), "utf8"),
    "other task",
  );
  assert.equal((await lstat(f.outside)).mode & 0o777, 0o500);
  assert.equal(
    await readFile(join(f.sibling, "keep.txt"), "utf8"),
    "not this invocation",
  );
  assert.equal((await readdir(f.archives)).length, 2);
}
test("successful preparation removes read-only build trees but keeps exact private evidence and shared archives", async (t) => {
  const f = await fixture(t);
  const result = await prepareNativeAudit(f.repository, f.sourceSha, f.reports);
  assert.equal(result.affectedImportedPackages, 0);
  const works = await retainedWorks(f);
  assert.equal(works.length, 1);
  await assertRetired(f, works[0], true);
});
test("failed child preparation still retires only its bulk scratch and preserves diagnostics", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(
    prepareNativeAudit(f.repository, f.sourceSha, f.reports),
    /Native asset preparation failed/,
  );
  const works = await retainedWorks(f);
  assert.equal(works.length, 1);
  await assertRetired(f, works[0], false);
});
test("repeated audits retain separate small reports without accumulating any compiler or module caches", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++)
    await prepareNativeAudit(f.repository, f.sourceSha, f.reports);
  const works = await retainedWorks(f);
  assert.equal(works.length, 3);
  for (const work of works) await assertRetired(f, work, true);
});

test("uncertain nested-group drain retains build scratch and diagnostics for safe recovery", async (t) => {
  const f = await fixture(t, "uncertain");
  await assert.rejects(
    prepareNativeAudit(f.repository, f.sourceSha, f.reports),
    (error) => {
      assert.equal(error.code, "NATIVE_GROUP_DRAIN");
      return true;
    },
  );
  const works = await retainedWorks(f);
  assert.equal(works.length, 1);
  for (const name of ["source", "compiler", "cache", "tmp", "audit-tools"])
    assert.ok((await lstat(join(works[0], "audit", name))).isDirectory());
  assert.match(
    await readFile(join(works[0], "audit.log"), "utf8"),
    /owned builder diagnostic/,
  );
});
