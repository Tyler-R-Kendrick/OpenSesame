import {
  type VaultHeader,
  assertFactorConfigurationBinding,
  createVault,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";
import { openText, sealText } from "../vault/unlock-factor-crypto.js";
import { readPagesRetiredCredentialHeader as read } from "./context-v2-header.js";
import { deriveRetiredCredentialContextV2 as derive } from "./context-v2.js";
import vectors from "./fixtures/context-v2-vectors.json";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required crypto fixture missing");
  return value;
}
const PASSWORD = "context factor binding real owner 53947";
let root: Uint8Array;
let key: CryptoKey;
let original: VaultHeader;
let bound: VaultHeader;
async function modern(header: VaultHeader): Promise<VaultHeader> {
  const manifest = migrateLegacyHeaderToManifest({
    header,
    passkeyRpId: "owner.example.invalid",
    vaultId: "factor-context-vault",
    rootKeyId: "factor-context-root",
    rootEpoch: 1,
  }).manifest;
  return {
    ...header,
    protection: await sealAuthenticatedManifest(root, manifest),
  };
}
/** Fixture signing only: this is not production enrollment or a full-factor permit. */
async function bind(header: VaultHeader): Promise<VaultHeader> {
  const factorConfiguration = await prepareFactorConfigurationBinding(header);
  return {
    ...header,
    protection: await sealAuthenticatedManifest(root, {
      ...manifestWithoutAuth(required(header.protection)),
      factorConfiguration,
    }),
  };
}
beforeAll(async () => {
  const made = await createVault(PASSWORD);
  root = made.rawVaultKey;
  key = made.vaultKey;
  original = await modern(made.header);
  bound = await bind(original);
}, 30000);
describe("inactive Pages context factor-binding extension", () => {
  it("preserves a genuine MAC-covered binding and includes it in the generation preimage", async () => {
    const parsed = read(JSON.stringify(bound));
    expect(parsed.protection.factorConfiguration).toEqual(
      required(bound.protection).factorConfiguration,
    );
    await verifyManifestAuth(root, parsed.protection);
    await assertFactorConfigurationBinding(parsed);
    const previous = await derive("personal", JSON.stringify(original));
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const next = await derive("personal", JSON.stringify(bound));
      const input = digest.mock.calls[0]?.[1];
      if (!(input instanceof Uint8Array))
        throw new Error("Actual context generation bytes missing");
      const fragment = `"factorConfiguration":{"digestB64":${JSON.stringify(required(parsed.protection.factorConfiguration).digestB64)},"version":1}`;
      expect(new TextDecoder().decode(input)).toContain(fragment);
      expect(next.generationSha256).not.toBe(previous.generationSha256);
      expect(next.rootKeyId).toBe(previous.rootKeyId);
    } finally {
      digest.mockRestore();
    }
  });
  it("agrees with independent public binding, real manifest-MAC and generation vectors", async () => {
    const publicHeader = read(required(vectors.vectors[0]).rawHeaderJson);
    const publicRoot = new Uint8Array(32).fill(17);
    await verifyManifestAuth(publicRoot, publicHeader.protection);
    const factorConfiguration =
      await prepareFactorConfigurationBinding(publicHeader);
    expect(factorConfiguration.digestB64).toBe(
      "9WPTYyJZyi+sh8N4Iircy8e5JUTZxlINpQHal1kI04g=",
    );
    const protection = await sealAuthenticatedManifest(publicRoot, {
      ...manifestWithoutAuth(publicHeader.protection),
      factorConfiguration,
    });
    expect(protection.authB64).toBe(
      "sD+Adam2q4EhU27hUojezDt9zhhQnEPPTr6YGi3WGE0=",
    );
    const next = read(JSON.stringify({ ...publicHeader, protection }));
    await verifyManifestAuth(publicRoot, next.protection);
    await assertFactorConfigurationBinding(next);
    expect(
      (await derive("personal", JSON.stringify(next))).generationSha256,
    ).toBe("28747f4472798fa6811085fb6ae17ba32c06cb331ab4cc7f56417840bdec9192");
  });
  it("keeps optional absence readable as data while the genuine strict comparator refuses it", async () => {
    const parsed = read(JSON.stringify(original));
    expect(parsed.protection.factorConfiguration).toBeUndefined();
    await verifyManifestAuth(root, parsed.protection);
    await expect(assertFactorConfigurationBinding(parsed)).rejects.toThrow(
      /binding/,
    );
  });
  it("refuses malformed, unknown, noncanonical or authority-bearing binding fields", () => {
    const raw = JSON.stringify(bound);
    const good = required(required(bound.protection).factorConfiguration);
    for (const factorConfiguration of [
      null,
      {},
      { ...good, version: 2 },
      { ...good, digestB64: `${"A".repeat(42)}B=` },
      { ...good, digestB64: "A".repeat(43) },
      { ...good, digestB64: "A".repeat(44) },
      { ...good, digestB64: "A".repeat(48) },
      { ...good, ownerPermit: true },
    ]) {
      expect(() =>
        read(
          JSON.stringify({
            ...bound,
            protection: { ...bound.protection, factorConfiguration },
          }),
        ),
      ).toThrow("context is unavailable");
    }
    const alias = raw.replace('"version":1', '"version":1.0000000000000001');
    expect(alias).not.toBe(raw);
    const parser = vi.spyOn(JSON, "parse");
    try {
      expect(() => read(alias)).toThrow("context is unavailable");
      expect(
        parser.mock.calls.filter(([v]) => /^(?:\{|\[)/.test(v.trimStart())),
      ).toHaveLength(0);
    } finally {
      parser.mockRestore();
    }
  });
  it("treats a well-shaped substituted digest as data and requires the real MAC/comparator", async () => {
    const altered = read(
      JSON.stringify({
        ...bound,
        protection: {
          ...bound.protection,
          factorConfiguration: { version: 1, digestB64: btoa("\0".repeat(32)) },
        },
      }),
    );
    expect(altered.protection.factorConfiguration?.version).toBe(1);
    await expect(
      verifyManifestAuth(root, altered.protection),
    ).rejects.toMatchObject({ code: "manifest_auth_failed" });
    await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
      /binding mismatch/,
    );
  });
  it("cannot authenticate replayed genuine same-root TOTP ciphertext from metadata alone", async () => {
    const firstWrap = await sealText(key, "JBSWY3DPEHPK3PXP");
    const nextWrap = await sealText(key, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const fresh = await bind(
      await modern({
        ...original,
        unlocks: { totp: { secretWrap: nextWrap, digits: 6, period: 30 } },
      }),
    );
    const replay = read(
      JSON.stringify({
        ...fresh,
        unlocks: { totp: { secretWrap: firstWrap, digits: 6, period: 30 } },
      }),
    );
    await verifyManifestAuth(root, replay.protection);
    await expect(openText(key, firstWrap)).resolves.toBe("JBSWY3DPEHPK3PXP");
    await assertFactorConfigurationBinding(fresh);
    await expect(assertFactorConfigurationBinding(replay)).rejects.toThrow(
      /binding mismatch/,
    );
    const a = await derive("personal", JSON.stringify(fresh));
    const b = await derive("personal", JSON.stringify(replay));
    expect(b.rootKeyId).toBe(a.rootKeyId);
    expect(b.generationSha256).not.toBe(a.generationSha256);
  });
});
