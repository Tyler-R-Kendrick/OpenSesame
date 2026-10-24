import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  oracleCacheDir,
  provisionOracle,
  provisionTreedump,
} from "./oracle.mjs";

test("oracle refuses symlink and public caches before accepting helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "oracle-private-test-"));
  const saved = process.env.SOPS_ORACLE_DIR;
  try {
    const target = join(dir, "public");
    mkdirSync(target, { mode: 0o755 });
    const cache = join(dir, "cache");
    symlinkSync(target, cache);
    process.env.SOPS_ORACLE_DIR = cache;
    assert.throws(() => oracleCacheDir(), /private owned directory/);
    assert.match(
      provisionOracle({ allowDownload: false }).error,
      /private owned directory/,
    );
    assert.match(provisionTreedump().error, /private owned directory/);
    rmSync(cache);
    assert.equal(oracleCacheDir(), cache);
    process.env.SOPS_ORACLE_DIR = join(dir, "nested", "private", "cache");
    assert.equal(oracleCacheDir(), process.env.SOPS_ORACLE_DIR);
    assert.match(
      provisionOracle({ allowDownload: false }).error,
      /downloads are disabled/,
    );
  } finally {
    if (saved === undefined)
      Reflect.deleteProperty(process.env, "SOPS_ORACLE_DIR");
    else process.env.SOPS_ORACLE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
