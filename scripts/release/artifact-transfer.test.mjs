import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertArtifact, downloadArtifact } from "./artifact-transfer.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const base = {
  repository: "owner/repo",
  token: "never-forward-me",
  artifactId: "9",
  runId: "123",
  runAttempt: "2",
  expectedName: `${"a".repeat(40)}-123-2-complete`,
};
function fixture(kind = "valid") {
  const work = mkdtempSync(join(tmpdir(), "artifact-transfer-test-"));
  const path = join(work, "fixture.zip");
  execFileSync(
    "python3",
    [
      "-c",
      `import sys,zipfile,stat
with zipfile.ZipFile(sys.argv[1],'w') as z:
 name='../escape' if sys.argv[2]=='traversal' else 'candidate.json'
 item=zipfile.ZipInfo(name)
 item.create_system=3
 item.external_attr=((stat.S_IFLNK|0o777) if sys.argv[2]=='symlink' else (stat.S_IFREG|0o644))<<16
 z.writestr(item,b'candidate')
 if sys.argv[2]=='duplicate': z.writestr(name,b'duplicate')
`,
      path,
      kind,
    ],
    { stdio: "pipe" },
  );
  const bytes = readFileSync(path);
  const options = {
    ...base,
    destination: join(work, "out"),
    artifactDigest: hash(bytes),
  };
  const metadata = {
    id: 9,
    name: base.expectedName,
    workflow_run: { id: 123 },
    expired: false,
    digest: `sha256:${hash(bytes)}`,
  };
  const fetcher = async (address, init) => {
    const url = String(address);
    if (url.endsWith("/zip"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixture.blob.core.windows.net/artifact" },
      });
    if (url.includes("blob.core.windows.net")) {
      assert.equal(
        init.headers,
        undefined,
        "the GitHub token must never reach signed storage",
      );
      assert.equal(init.redirect, "error");
      return new Response(bytes);
    }
    return Response.json(metadata);
  };
  return { work, options, metadata, fetcher };
}

test("download verifies authenticated metadata and ZIP bytes before safely extracting", async () => {
  const f = fixture();
  try {
    await downloadArtifact({ ...f.options, fetcher: f.fetcher });
    assert.equal(
      readFileSync(join(f.options.destination, "candidate.json"), "utf8"),
      "candidate",
    );
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test("metadata rejects wrong run, attempt/name, ID, digest and expiry", () => {
  const f = fixture();
  try {
    for (const bad of [
      { id: 10 },
      { workflow_run: { id: 124 } },
      { name: base.expectedName.replace("-2-", "-1-") },
      { expired: true },
      { digest: `sha256:${"0".repeat(64)}` },
    ])
      assert.throws(() => assertArtifact({ ...f.metadata, ...bad }, f.options));
    assert.throws(() =>
      assertArtifact(f.metadata, { ...f.options, runAttempt: "1" }),
    );
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

test("download fails on actual byte corruption even when metadata claims the expected digest", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      downloadArtifact({
        ...f.options,
        fetcher: (url, init) =>
          String(url).includes("blob.core.windows.net")
            ? Promise.resolve(new Response("corrupt"))
            : f.fetcher(url, init),
      }),
      /Downloaded artifact digest mismatch/,
    );
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

for (const kind of ["traversal", "symlink", "duplicate"])
  test(`ZIP ${kind} is rejected before extraction`, async () => {
    const f = fixture(kind);
    try {
      await assert.rejects(
        downloadArtifact({ ...f.options, fetcher: f.fetcher }),
      );
    } finally {
      rmSync(f.work, { recursive: true, force: true });
    }
  });
