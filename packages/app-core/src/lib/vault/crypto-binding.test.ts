import {
  createVault,
  openJson,
  openJsonForRebind,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";

const PASSWORD = "correct horse battery staple";

describe("vault seal binding", () => {
  it("refuses a body sealed for one tomb when opened as another", async () => {
    const created = await createVault(PASSWORD);
    const personal = vaultSealBinding("personal", "body");
    const blob = await sealJson(
      created.vaultKey,
      { v: 1, items: [] },
      personal,
    );
    await expect(
      openJson(created.vaultKey, blob, vaultSealBinding("guest", "body")),
    ).rejects.toThrow(/authentication tag/);
    await expect(openJson(created.vaultKey, blob, personal)).resolves.toEqual({
      v: 1,
      items: [],
    });
    created.rawVaultKey.fill(0);
  });

  it("refuses an unbound seal on the bound open path", async () => {
    const created = await createVault(PASSWORD);
    const blob = await sealJson(created.vaultKey, { v: 1, items: [] });
    await expect(
      openJson(created.vaultKey, blob, vaultSealBinding("personal", "body")),
    ).rejects.toThrow(/authentication tag/);
    const rebound = await openJsonForRebind<{ v: number; items: never[] }>(
      created.vaultKey,
      blob,
      vaultSealBinding("personal", "body"),
    );
    expect(rebound.rebound).toBe(true);
    expect(rebound.value).toEqual({ v: 1, items: [] });
    const bound = await sealJson(
      created.vaultKey,
      { v: 1, items: [] },
      vaultSealBinding("personal", "body"),
    );
    await expect(
      openJson(created.vaultKey, bound, vaultSealBinding("personal", "body")),
    ).resolves.toEqual({ v: 1, items: [] });
    created.rawVaultKey.fill(0);
  });
});
