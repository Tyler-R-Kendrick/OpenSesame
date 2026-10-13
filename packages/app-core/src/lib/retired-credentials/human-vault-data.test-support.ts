import {
  type SealedBlob,
  type VaultHeader,
  createVault,
  sealJson,
  unwrapRawVaultKeyFromPassword,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { expect } from "vitest";
import { sealAuthenticatedManifest } from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";

export const tomb = "owner-test";
const password = "Public owner data crypto fixture";
export const absent = {
  totpEnrolled: false,
  emailEnrolled: false,
  smsEnrolled: false,
  recoveryCodesEnrolled: false,
};
export const unavailable = "Human vault data is unavailable.";
export type Fixture = {
  root: Uint8Array;
  header: VaultHeader;
  body: SealedBlob;
};

async function fixture(): Promise<Fixture> {
  const created = await createVault(password);
  let root: Uint8Array | undefined;
  try {
    root = await unwrapRawVaultKeyFromPassword(created.header, password);
    expect(root).toEqual(created.rawVaultKey);
    const migrated = migrateLegacyHeaderToManifest({
      header: created.header,
      vaultId: "opaque-vault-id",
      rootKeyId: "opaque-root-id",
      rootEpoch: 3,
      passkeyRpId: "example.invalid",
    });
    const manifest = { ...migrated.manifest, revision: 5 };
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]).toMatchObject({
      kind: "password",
      legacy: true,
      kdf: created.header.kdf,
      wrap: created.header.wrap,
    });
    return {
      root,
      header: {
        ...created.header,
        protection: await sealAuthenticatedManifest(root, manifest),
      },
      body: await sealJson(
        created.vaultKey,
        { v: 1, rev: 0, items: [], folders: [] },
        vaultSealBinding(tomb, "body"),
      ),
    };
  } catch (error) {
    root?.fill(0);
    throw error;
  } finally {
    created.rawVaultKey.fill(0);
  }
}

export async function useFixture(
  work: (value: Fixture) => Promise<void>,
): Promise<void> {
  const value = await fixture();
  try {
    await work(value);
  } finally {
    value.root.fill(0);
  }
}
