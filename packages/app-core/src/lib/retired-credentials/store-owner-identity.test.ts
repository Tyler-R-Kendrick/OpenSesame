import { createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requiresFreshOwnerAuthentication } from "../decoy-session.js";
import { hostFetch, identitySeams } from "../identity.js";
import { kvSet } from "../kv.js";
import { sealAuthenticatedManifest } from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";
import { VaultStore } from "../vault/store.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import { PASSWORD, createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
let other: VaultStore | null = null;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  other?.lock();
  other = null;
  fixture.restore();
  vi.restoreAllMocks();
});
it.each([false, true])(
  "refuses a fresh root from another protected vault named personal (forged identity %s)",
  async (forged) => {
    const original = fixture.store.getSnapshot().header;
    if (!original?.protection)
      throw new Error("Expected original authenticated manifest");
    const minted = await createVault("different owner password");
    const projection = migrateLegacyHeaderToManifest({ header: minted.header });
    const protection = await sealAuthenticatedManifest(
      minted.rawVaultKey,
      projection.manifest,
    );
    minted.rawVaultKey.fill(0);
    if (forged) protection.vaultId = original.protection.vaultId;
    const foreign = { ...minted.header, protection };
    fixture.store.lock();
    await fixture.store.createGuest({
      decoy: true,
      resume: false,
      isolated: true,
    });
    fixture.store.lock();
    // A second storage/domain's genuinely password-wrapped root has the same logical tomb name.
    kvSet(tombFileKey("personal", HEADER_PATH), JSON.stringify(foreign));
    other = new VaultStore();
    const transport = vi
      .spyOn(identitySeams, "hostFetch")
      .mockResolvedValue(new Response("member data"));
    await expect(other.unlock("different owner password")).rejects.toThrow();
    expect(other.isUnlocked()).toBe(false);
    expect(other.getSnapshot().items).toEqual([]);
    expect(requiresFreshOwnerAuthentication()).toBe(true);
    await expect(hostFetch("/api/v1/member")).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    other.lock();
    other = null;
    kvSet(tombFileKey("personal", HEADER_PATH), JSON.stringify(original));
    await fixture.store.unlock(PASSWORD);
    expect(requiresFreshOwnerAuthentication()).toBe(false);
    await expect(hostFetch("/api/v1/member")).resolves.toBeInstanceOf(Response);
  },
);
