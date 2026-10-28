import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("build-manifest.py", import.meta.url));
const fixtures = `import io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]); case=sys.argv[2]
(root/'production').mkdir(); (root/'test-only').mkdir()
bridge=b'bridge'; marker=b'OPENSESAME_SURROGATE_TEST_UPSTREAM'
(root/'production/opensesame-env-parse.mjs').write_bytes(bridge)
def archive(path, entries):
 with tarfile.open(path,'w:gz') as tar:
  for name,data in entries:
   info=tarfile.TarInfo(name)
   if data is None:
    info.type=tarfile.SYMTYPE; info.linkname='/tmp/escape'; tar.addfile(info)
   else:
    info.size=len(data); tar.addfile(info,io.BytesIO(data))
pages=[('index.html',b'html'),('404.html',b'html'),('os-runtime-config.json',b'{}'),
 ('release.json',json.dumps({'revision':('b' if case=='source' else 'a')*40}).encode()),
 ('security-profile.json',json.dumps({'profile':'wrong' if case=='profile' else 'shared_origin_demo','canonicalOrigin':'https://tyler-r-kendrick.github.io'}).encode())]
if case=='traversal': pages.append(('../escape',b'escape'))
if case=='symlink': pages.append(('link',None))
if case=='duplicate': pages.append(('index.html',b'duplicate'))
if case=='incomplete': pages=[p for p in pages if p[0]!='release.json']
archive(root/'production/opensesame-pages_v0.2.0.tar.gz',pages)
for target in ('x86_64-unknown-linux-gnu','aarch64-unknown-linux-gnu'):
 kit='opensesame-kit_v0.2.0_'+target
 files=[(kit+'/LICENSE',b'license'),(kit+'/opensesame',b'CLI'),(kit+'/opensesame-surrogate-proxy',marker if case=='production-marker' else b'proxy'),
 (kit+'/opensesame-env-parse.mjs',b'different' if case=='bridge' else bridge)]
 if case=='native-extra': files.append((kit+'/extra',b'extra'))
 archive(root/'production'/str(kit+'.tar.gz'),files)
 name='opensesame-surrogate-proxy-TEST-upstream-override'; kit=name+'_v0.2.0_'+target
 archive(root/'test-only'/str(kit+'.tar.gz'),[(kit+'/LICENSE',b'license'),(kit+'/'+name,b'test' if case=='test-marker' else marker)])
if case=='missing': (root/'production/opensesame-kit_v0.2.0_x86_64-unknown-linux-gnu.tar.gz').unlink()
if case=='extra': (root/'production/extra').write_text('extra')
if case=='filesystem-symlink': (root/'production/link').symlink_to('opensesame-env-parse.mjs')
`;
function runFixture(kind) {
  const work = mkdtempSync(join(tmpdir(), "build-manifest-test-"));
  execFileSync("python3", ["-c", fixtures, work, kind]);
  const env = {
    ...process.env,
    SOURCE_SHA: "a".repeat(40),
    VERSION: "0.2.0",
    CANDIDATE_ID: `${"a".repeat(40)}-123-1`,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "owner/repo/.github/workflows/dev-nightly.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    SOURCE_CI_RUN_ID: "122",
    SOURCE_CI_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: join(work, "output"),
  };
  return {
    work,
    result: spawnSync("python3", [script, work], { env, encoding: "utf8" }),
  };
}

test("complete candidate has six exact production/test payloads and canonical manifest digest", () => {
  const { work, result } = runFixture("valid");
  try {
    assert.equal(result.status, 0, result.stderr);
    const bytes = readFileSync(join(work, "candidate.json"));
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.payloads.length, 6);
    assert.equal(
      manifest.payloads.filter((p) => p.role === "production").length,
      4,
    );
    assert.equal(
      manifest.payloads.filter((p) => p.role === "test-only").length,
      2,
    );
    for (const payload of manifest.payloads) {
      const file = readFileSync(join(work, payload.path));
      assert.equal(file.length, payload.size);
      assert.equal(
        createHash("sha256").update(file).digest("hex"),
        payload.sha256,
      );
    }
    assert.equal(
      readFileSync(join(work, "output"), "utf8"),
      `payload_digest=${createHash("sha256").update(bytes).digest("hex")}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

for (const kind of [
  "missing",
  "extra",
  "filesystem-symlink",
  "traversal",
  "symlink",
  "duplicate",
  "source",
  "profile",
  "incomplete",
  "bridge",
  "production-marker",
  "test-marker",
  "native-extra",
]) {
  test(`candidate rejects ${kind} without minting a manifest`, () => {
    const { work, result } = runFixture(kind);
    try {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(work, "candidate.json")), false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
