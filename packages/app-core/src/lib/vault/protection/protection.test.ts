import { describe, expect, it } from "vitest";
import {
  type ProtectionContext,
  ProtectionError,
  type RootProtectionManifest,
  WRAPPING_SECRET_BYTES,
  assertCanRemoveProtector,
  authenticateManifest,
  canonicalizeToString,
  createCloudLocalEnvelope,
  openCloudLocalEnvelope,
  openRootCapsule,
  parseRootProtectionManifest,
  sealAuthenticatedManifest,
  sealRootCapsule,
} from "./index.js";

async function aesKeyFromRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

describe("vault root protection MODEL", () => {
  const context: ProtectionContext = {
    vaultId: "vault_a",
    rootKeyId: "root_a",
    rootEpoch: 1,
    protectorId: "prot_a",
    purpose: "human-vault-root",
  };

  it("KP-18 rejects capsule opened under swapped vault context", async () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const kek = await aesKeyFromRaw(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealRootCapsule(kek, context, root);
    const swapped = { ...context, vaultId: "vault_b" };
    await expect(openRootCapsule(kek, swapped, sealed)).rejects.toBeInstanceOf(
      ProtectionError,
    );
  });

  it("KP-19 rejects tampered manifest authentication", async () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const base: Omit<RootProtectionManifest, "authB64"> = {
      schemaVersion: 1,
      vaultId: "vault_a",
      rootKeyId: "root_a",
      rootEpoch: 1,
      revision: 3,
      purpose: "human-vault-root",
      records: [],
    };
    const sealed = await sealAuthenticatedManifest(root, base);
    const tampered = {
      ...sealed,
      revision: 99,
    };
    await expect(
      authenticateManifest(root, {
        schemaVersion: tampered.schemaVersion,
        vaultId: tampered.vaultId,
        rootKeyId: tampered.rootKeyId,
        rootEpoch: tampered.rootEpoch,
        revision: tampered.revision,
        purpose: tampered.purpose,
        records: tampered.records,
      }).then((tag) => {
        expect(tag).not.toEqual(sealed.authB64);
      }),
    ).resolves.toBeUndefined();
    const { verifyManifestAuth } = await import("./manifest-auth.js");
    await expect(verifyManifestAuth(root, tampered)).rejects.toMatchObject({
      code: "manifest_auth_failed",
    });
  });

  it("KP-20 rejects oversized record counts and duplicate ids", () => {
    const records = Array.from({ length: 65 }, (_, i) => ({
      kind: "password",
      protectorId: `p${i}`,
      legacy: true,
      kdf: { alg: "PBKDF2-SHA256", saltB64: "YQ==", iterations: 600000 },
      wrap: { ivB64: "YQ==", ctB64: "YQ==" },
      proofStatus: "verified",
    }));
    expect(() =>
      parseRootProtectionManifest(
        JSON.stringify({
          schemaVersion: 1,
          vaultId: "v",
          rootKeyId: "r",
          rootEpoch: 0,
          revision: 0,
          purpose: "human-vault-root",
          records,
        }),
      ),
    ).toThrowError(/64/);

    expect(() =>
      parseRootProtectionManifest(
        JSON.stringify({
          schemaVersion: 1,
          vaultId: "v",
          rootKeyId: "r",
          rootEpoch: 0,
          revision: 0,
          purpose: "human-vault-root",
          records: [
            {
              kind: "password",
              protectorId: "same",
              legacy: true,
              kdf: {
                alg: "PBKDF2-SHA256",
                saltB64: "YQ==",
                iterations: 600000,
              },
              wrap: { ivB64: "YQ==", ctB64: "YQ==" },
              proofStatus: "verified",
            },
            {
              kind: "pin",
              protectorId: "same",
              legacy: true,
              saltB64: "YQ==",
              iterations: 600000,
              wrap: { ivB64: "YQ==", ctB64: "YQ==" },
              proofStatus: "verified",
            },
          ],
        }),
      ),
    ).toThrowError(/Duplicate protectorId/);
  });

  it("canonicalization is key-order insensitive", () => {
    const a = canonicalizeToString({ b: 1, a: 2 });
    const b = canonicalizeToString({ a: 2, b: 1 });
    expect(a).toEqual(b);
  });

  it("KP-31 cloud envelope keeps wrapping secret at 32 bytes", async () => {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const env = await createCloudLocalEnvelope(context, root);
    expect(env.wrappingSecret.byteLength).toBe(WRAPPING_SECRET_BYTES);
    const opened = await openCloudLocalEnvelope(
      context,
      env.wrappingSecret,
      env.localCapsule,
    );
    expect(Buffer.from(opened).equals(Buffer.from(root))).toBe(true);
  });

  it("KP-11 refuses removing the last verified path", () => {
    const manifest: RootProtectionManifest = {
      schemaVersion: 1,
      vaultId: "v",
      rootKeyId: "r",
      rootEpoch: 0,
      revision: 1,
      purpose: "human-vault-root",
      records: [
        {
          kind: "password",
          protectorId: "only",
          legacy: true,
          kdf: { alg: "PBKDF2-SHA256", saltB64: "YQ==", iterations: 600000 },
          wrap: { ivB64: "YQ==", ctB64: "YQ==" },
          proofStatus: "verified",
        },
      ],
    };
    expect(() => assertCanRemoveProtector(manifest, "only")).toThrowError(
      /last verified/,
    );
  });

  it("shared vectors: capsule and manifest MAC match fixture bytes", async () => {
    const vectors = await import("./fixtures/shared-vectors.json");
    const kek = await aesKeyFromRaw(
      Uint8Array.from(Buffer.from(vectors.capsule.kekHex, "hex")),
    );
    const root = Uint8Array.from(
      Buffer.from(vectors.capsule.rootKeyHex, "hex"),
    );
    const iv = Uint8Array.from(Buffer.from(vectors.capsule.ivHex, "hex"));
    // SAFETY: shared-vectors fixture is authored to match ProtectionContext.
    const capsuleContext = vectors.capsule.context as ProtectionContext;
    const sealed = await sealRootCapsule(kek, capsuleContext, root, iv);
    expect(sealed.ivB64).toEqual(vectors.capsule.ivB64);
    expect(sealed.ctB64).toEqual(vectors.capsule.ctB64);
    const opened = await openRootCapsule(kek, capsuleContext, sealed);
    expect(Buffer.from(opened).equals(Buffer.from(root))).toBe(true);

    const rootKey = Uint8Array.from(
      Buffer.from(vectors.manifestAuth.rootKeyHex, "hex"),
    );
    // SAFETY: shared-vectors fixture matches Omit<RootProtectionManifest,"authB64">.
    const manifestBody = vectors.manifestAuth.manifest as Omit<
      RootProtectionManifest,
      "authB64"
    >;
    const sealedManifest = await sealAuthenticatedManifest(
      rootKey,
      manifestBody,
    );
    expect(sealedManifest.authB64).toEqual(vectors.manifestAuth.authTagB64);
  });

  it("KP-20 rejects duplicate JSON keys before crypto", () => {
    expect(() =>
      parseRootProtectionManifest(
        '{"schemaVersion":1,"schemaVersion":2,"vaultId":"v","rootKeyId":"r","rootEpoch":0,"revision":0,"purpose":"human-vault-root","records":[]}',
      ),
    ).toThrow(/Duplicate JSON key/);
  });

  it("KP-04 encryption preference alone is not enrollment", async () => {
    const { encryptionSetupIntentFromBinding, migrateLegacyHeaderToManifest } =
      await import("./migrate-legacy.js");
    const intent = encryptionSetupIntentFromBinding(
      "aws-kms",
      "conn_1",
      new Set(),
    );
    expect(intent?.source).toBe("capabilityConnectors.encryption");
    const migrated = migrateLegacyHeaderToManifest({
      header: {
        v: 1,
        createdAt: new Date().toISOString(),
      },
    });
    expect(migrated.manifest.records).toEqual([]);
  });
});
