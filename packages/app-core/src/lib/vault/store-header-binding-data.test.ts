/** Real root-MAC and full-policy transition crypto; helper results are DATA, not admission. */
import {
  assertFactorConfigurationBinding,
  importVaultKey,
} from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import { useFixture } from "../retired-credentials/human-vault-data.test-support.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./protection/manifest-auth.js";
import { bindOriginalHeaderPolicy } from "./store-header-binding-data.js";
import { sealTotpSecret } from "./unlock-methods.js";
it("binds a genuinely enrolled TOTP gate and preserves an unchanged authenticated header", async () => {
  await useFixture(async (f) => {
    const original = await bindOriginalHeaderPolicy(
      null,
      f.header,
      f.root,
      false,
      () => {},
    );
    const gate = await sealTotpSecret(
      await importVaultKey(f.root),
      "JBSWY3DPEHPK3PXP",
    );
    const next = await bindOriginalHeaderPolicy(
      original,
      { ...original, unlocks: { ...original.unlocks, totp: gate } },
      f.root,
      false,
      () => {},
    );
    expect(next.protection?.legacyGates?.totpEnrolled).toBe(true);
    await assertFactorConfigurationBinding(next);
    if (!next.protection) throw new Error("Missing bound manifest");
    await verifyManifestAuth(f.root, next.protection);
    expect(
      readPagesRetiredCredentialHeader(JSON.stringify(next)).unlocks?.totp,
    ).toEqual(gate);
    expect(
      await bindOriginalHeaderPolicy(next, next, f.root, false, () => {}),
    ).toBe(next);
  });
});
it("never repairs a present but corrupted prior factor policy", async () => {
  await useFixture(async (f) => {
    const original = await bindOriginalHeaderPolicy(
      null,
      f.header,
      f.root,
      false,
      () => {},
    );
    const gate = await sealTotpSecret(
      await importVaultKey(f.root),
      "JBSWY3DPEHPK3PXP",
    );
    const corrupt = {
      ...original,
      unlocks: { ...original.unlocks, totp: gate },
    };
    await expect(
      bindOriginalHeaderPolicy(corrupt, corrupt, f.root, false, () => {}),
    ).rejects.toThrow(/factor configuration/iu);
  });
});
it("refreshes full binding after an authenticated manifest revision change", async () => {
  await useFixture(async (f) => {
    const original = await bindOriginalHeaderPolicy(
      null,
      f.header,
      f.root,
      false,
      () => {},
    );
    if (!original.protection) throw new Error("Missing manifest");
    const proposed = {
      ...original,
      protection: await sealAuthenticatedManifest(f.root, {
        ...manifestWithoutAuth(original.protection),
        revision: original.protection.revision + 1,
      }),
    };
    const next = await bindOriginalHeaderPolicy(
      original,
      proposed,
      f.root,
      false,
      () => {},
    );
    await assertFactorConfigurationBinding(next);
    expect(next.protection?.revision).toBe(proposed.protection.revision);
  });
});
it("refuses a substituted root before signing a factor transition", async () => {
  await useFixture(async (f) => {
    const original = await bindOriginalHeaderPolicy(
      null,
      f.header,
      f.root,
      false,
      () => {},
    );
    const alien = crypto.getRandomValues(new Uint8Array(32));
    try {
      await expect(
        bindOriginalHeaderPolicy(original, original, alien, false, () => {}),
      ).rejects.toThrow();
    } finally {
      alien.fill(0);
    }
  });
});
