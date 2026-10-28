import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("archive-safe.py", import.meta.url));
function fixture(kind) {
  const work = mkdtempSync(join(tmpdir(), "safe-tar-test-"));
  const archive = join(work, "archive.tar.gz");
  execFileSync("python3", [
    "-c",
    `import io,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as tar:
 case=sys.argv[2]
 item=tarfile.TarInfo('../escape' if case=='traversal' else '/escape' if case=='absolute' else 'kit/cli')
 item.mode=0o4755
 if case in ('symlink','hardlink','device'):
  item.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'device':tarfile.CHRTYPE}[case]; item.linkname='/tmp/escape'; tar.addfile(item)
 else:
  item.size=3; tar.addfile(item,io.BytesIO(b'bin'))
  if case=='duplicate': tar.addfile(item,io.BytesIO(b'bin'))
`,
    archive,
    kind,
  ]);
  return { work, archive, out: join(work, "out") };
}

test("safe tar extraction retains execute permission without setuid bits", () => {
  const f = fixture("valid");
  try {
    execFileSync("python3", [extractor, "tar", f.archive, f.out]);
    assert.equal(readFileSync(join(f.out, "kit/cli"), "utf8"), "bin");
    assert.equal(statSync(join(f.out, "kit/cli")).mode & 0o7777, 0o755);
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});

for (const kind of [
  "traversal",
  "absolute",
  "symlink",
  "hardlink",
  "device",
  "duplicate",
])
  test(`tar ${kind} writes no extracted files`, () => {
    const f = fixture(kind);
    try {
      const result = spawnSync(
        "python3",
        [extractor, "tar", f.archive, f.out],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(f.out), false);
    } finally {
      rmSync(f.work, { recursive: true, force: true });
    }
  });

test("extraction refuses to merge into an existing populated directory", () => {
  const f = fixture("valid");
  try {
    mkdirSync(f.out);
    writeFileSync(join(f.out, "sentinel"), "keep");
    const result = spawnSync("python3", [extractor, "tar", f.archive, f.out], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(f.out, "sentinel"), "utf8"), "keep");
  } finally {
    rmSync(f.work, { recursive: true, force: true });
  }
});
