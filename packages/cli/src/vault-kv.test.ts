import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kvFileName,
  kvGet,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import { afterEach, describe, expect, it } from "vitest";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";

describe("shared sealed Node vault storage", () => {
  let stateDir = "";
  afterEach(async () => {
    await releaseVaultKv();
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  });
  it("migrates snapshots once without replacing newer records on replay", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "os-vault-kv-"));
    const path = join(stateDir, "vault-kv.json");
    const snapshot = JSON.stringify({
      "tomb/personal/header": "old-header",
      "tombs.v1": '["personal"]',
    });
    await writeFile(path, snapshot, { mode: 0o600 });
    await useVaultKv(stateDir);
    expect(kvGet("tomb/personal/header")).toBe("old-header");
    expect(await readFile(`${path}.migrated`, "utf8")).toBe(snapshot);
    await kvSetDurable("tomb/personal/header", "new-header");
    await releaseVaultKv();
    await writeFile(path, snapshot, { mode: 0o600 });
    await useVaultKv(stateDir);
    expect(kvGet("tomb/personal/header")).toBe("new-header");
  });
  it("refuses corrupt sealed targets without overwriting them from a legacy snapshot", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "os-vault-kv-corrupt-"));
    const key = "tomb/personal/header";
    await useVaultKv(stateDir);
    await kvSetDurable(key, "saved-header");
    await releaseVaultKv();
    const target = join(stateDir, "origin-files", kvFileName(key));
    const ciphertext = await readFile(target, "utf8");
    const corrupt = `${ciphertext.slice(0, -8)}AAAAAAAA`;
    await writeFile(target, corrupt, { mode: 0o600 });
    const legacyPath = join(stateDir, "vault-kv.json");
    const legacy = JSON.stringify({ [key]: "old-header" });
    await writeFile(legacyPath, legacy, { mode: 0o600 });
    await expect(useVaultKv(stateDir)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(corrupt);
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
  });
});
