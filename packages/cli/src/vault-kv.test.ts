import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vfsSeams } from "@opensesame/app-core/lib/vfs.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "os-vault-kv-"));
});

afterEach(async () => {
  await releaseVaultKv();
  await rm(stateDir, { recursive: true, force: true });
});

describe("the vault directory", () => {
  it("keeps each vault file as a file, and reads them back in the next process", async () => {
    await useVaultKv(stateDir);
    await vfsSeams.writeRaw("tomb/personal/header", '{"v":1}');
    await vfsSeams.writeRaw("tomb/personal/config/prefs", "sealed-prefs");
    expect(
      await readFile(join(stateDir, "vault/personal/header.json"), "utf8"),
    ).toBe('{"v":1}');
    expect(
      await readFile(
        join(stateDir, "vault/personal/config/prefs.json"),
        "utf8",
      ),
    ).toBe("sealed-prefs");

    await releaseVaultKv();
    expect(vfsSeams.readRaw("tomb/personal/header")).toBeNull();
    await useVaultKv(stateDir);
    expect(vfsSeams.readRaw("tomb/personal/header")).toBe('{"v":1}');
    expect(vfsSeams.readRaw("tomb/personal/config/prefs")).toBe("sealed-prefs");
  });

  it.skipIf(process.platform === "win32")("is owner-only", async () => {
    await useVaultKv(stateDir);
    await vfsSeams.writeRaw("tomb/personal/header", "{}");
    expect((await stat(join(stateDir, "vault"))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(stateDir, "vault/personal/header.json"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("refuses a record that is not a vault file instead of inventing a place for it", async () => {
    await useVaultKv(stateDir);
    await expect(vfsSeams.writeRaw("vault", "x")).rejects.toMatchObject({
      _tag: "SecretFsRejected",
    });
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("moves a vault left in the single-file snapshot onto files, keeping the snapshot", async () => {
    const registry = JSON.stringify({ v: 1, tombs: ["personal"] });
    await writeFile(
      join(stateDir, "vault-kv.json"),
      JSON.stringify({
        "tombs.v1": registry,
        "tomb/personal/header": '{"v":1}',
        "tomb/personal/body": '{"ivB64":"a","ctB64":"b"}',
      }),
    );
    await useVaultKv(stateDir);
    expect(vfsSeams.readRaw("tombs.v1")).toBe(registry);
    expect(await readFile(join(stateDir, "vault/tombs.json"), "utf8")).toBe(
      registry,
    );
    // The flat body stays a single file until the vault is opened and saved.
    expect(
      await readFile(join(stateDir, "vault/personal/body.json"), "utf8"),
    ).toContain("ctB64");
    expect(
      await readFile(join(stateDir, "vault-kv.json.migrated"), "utf8"),
    ).toContain("tombs.v1");
    await expect(stat(join(stateDir, "vault-kv.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not let an old snapshot overwrite a directory that already holds a vault", async () => {
    await useVaultKv(stateDir);
    await vfsSeams.writeRaw("tombs.v1", "current");
    await releaseVaultKv();
    await writeFile(
      join(stateDir, "vault-kv.json"),
      JSON.stringify({ "tombs.v1": "stale" }),
    );
    await useVaultKv(stateDir);
    expect(vfsSeams.readRaw("tombs.v1")).toBe("current");
    expect(await readFile(join(stateDir, "vault-kv.json"), "utf8")).toContain(
      "stale",
    );
  });

  it("keeps one directory open at a time", async () => {
    const other = await mkdtemp(join(tmpdir(), "os-vault-kv-"));
    try {
      await useVaultKv(stateDir);
      await vfsSeams.writeRaw("tomb/personal/header", "first");
      await useVaultKv(other);
      expect(vfsSeams.readRaw("tomb/personal/header")).toBeNull();
      await vfsSeams.writeRaw("tomb/personal/header", "second");
      await useVaultKv(stateDir);
      expect(vfsSeams.readRaw("tomb/personal/header")).toBe("first");
    } finally {
      await releaseVaultKv();
      await rm(other, { recursive: true, force: true });
    }
  });
});
