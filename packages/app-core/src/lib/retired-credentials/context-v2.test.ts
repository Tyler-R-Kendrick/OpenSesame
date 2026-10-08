import {
  type VaultHeader,
  createVault,
  openJson,
  rewrapVaultKey,
  sealJson,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "../vault/protection/migrate-legacy.js";
import {
  enrollRecoveryKey,
  openWithRecoveryKey,
} from "../vault/protection/recovery-key.js";
import {
  sealRecoveryLedger,
  sealText,
  sealTotpSecret,
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "../vault/unlock-methods.js";
import {
  RETIRED_CREDENTIAL_CONTEXT_FORMAT,
  deriveRetiredCredentialContextV2 as derive,
  encodeRetiredCredentialContextV2 as encode,
  parseRetiredCredentialContextV2 as parse,
} from "./context-v2.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required crypto fixture missing");
  return value;
}
const PASSWORD = "context original primary 84027";
const PIN = "84927361";
const AT = "2026-10-08T00:00:00.000Z";
let header: VaultHeader;
let rawRoot: Uint8Array;
let key: CryptoKey;
const prf = new Uint8Array(32).fill(71).buffer;

async function modern(next: VaultHeader): Promise<VaultHeader> {
  const migrated = migrateLegacyHeaderToManifest({
    header: next,
    passkeyRpId: "owner.example.invalid",
    vaultId: header?.protection?.vaultId,
    rootKeyId: header?.protection?.rootKeyId,
    rootEpoch: header?.protection?.rootEpoch,
  });
  return {
    ...next,
    protection: await sealAuthenticatedManifest(rawRoot, migrated.manifest),
  };
}
function copy(): VaultHeader {
  return structuredClone(header);
}
async function context(next = header) {
  return derive("personal", JSON.stringify(next));
}

beforeAll(async () => {
  const made = await createVault(PASSWORD);
  rawRoot = made.rawVaultKey;
  key = made.vaultKey;
  const passkey = await wrapVaultKeyWithPrf(
    rawRoot,
    prf,
    new Uint8Array(32).fill(73),
    new Uint8Array([19, 20]).buffer,
    new Uint8Array([21]).buffer,
  );
  header = await modern({
    ...made.header,
    createdAt: AT,
    unlocks: {
      pin: await wrapVaultKeyWithPin(rawRoot, PIN),
      passkey,
      passkeys: [passkey],
      totp: await sealTotpSecret(key, "JBSWY3DPEHPK3PXP"),
      email: {
        toWrap: await sealText(key, "owner@example.invalid"),
        since: AT,
      },
      sms: { toWrap: await sealText(key, "+12025550123"), since: AT },
      recovery: {
        codesWrap: await sealRecoveryLedger(key, {
          codes: ["fixture-4827"],
          used: [false],
        }),
        total: 1,
        since: AT,
      },
    },
  });
  expect(await unwrapRawVaultKeyFromPassword(header, PASSWORD)).toEqual(
    rawRoot,
  );
  expect(
    await unwrapVaultKeyWithPin(required(required(header.unlocks).pin), PIN),
  ).toEqual(rawRoot);
  expect(await unwrapVaultKeyWithPrf(passkey, prf)).toEqual(rawRoot);
  await verifyManifestAuth(rawRoot, required(header.protection));
  const body = await sealJson(
    key,
    { title: "real encrypted owner fixture" },
    "context-fixture-body",
  );
  expect(await openJson(key, body, "context-fixture-body")).toEqual({
    title: "real encrypted owner fixture",
  });
}, 30000);

describe("inactive Pages retired context public workflow data", () => {
  it("round-trips a genuine modern password/PIN/PRF and configured-factor header without retaining wraps", async () => {
    const value = await context();
    expect(value).toMatchObject({
      v: 2,
      format: RETIRED_CREDENTIAL_CONTEXT_FORMAT,
      tomb: "personal",
      purpose: "human-vault-root",
      vaultId: required(header.protection).vaultId,
      rootKeyId: required(header.protection).rootKeyId,
      rootEpoch: 0,
    });
    expect(parse(encode(value))).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(value).sort()).toEqual([
      "format",
      "generationSha256",
      "purpose",
      "rootEpoch",
      "rootKeyId",
      "tomb",
      "v",
      "vaultId",
    ]);
    expect(encode(value)).not.toContain(required(header.wrap).ctB64);
    expect(encode(value)).not.toContain(PASSWORD);
  });
  it("retains exact generation across property order and ordinary body revisions", async () => {
    const reordered = {
      protection: header.protection,
      unlocks: header.unlocks,
      wrap: header.wrap,
      kdf: header.kdf,
      createdAt: header.createdAt,
      v: 1,
      bodyRev: 812,
    };
    expect(await derive("personal", JSON.stringify(reordered))).toEqual(
      await context(),
    );
    const m = required(header.protection);
    const reversedManifest = Object.fromEntries(Object.entries(m).reverse());
    expect(
      await derive(
        "personal",
        JSON.stringify({ ...header, protection: reversedManifest }),
      ),
    ).toEqual(await context());
  });
  it("supports an actual PIN/PRF-only header after password removal", async () => {
    const { kdf: _kdf, wrap: _wrap, ...withoutPassword } = copy();
    const next = await modern(withoutPassword);
    await verifyManifestAuth(rawRoot, required(next.protection));
    expect(
      await unwrapVaultKeyWithPin(required(required(next.unlocks).pin), PIN),
    ).toEqual(rawRoot);
    expect((await context(next)).generationSha256).not.toBe(
      (await context()).generationSha256,
    );
  }, 30000);
  it("captures the immutable public generation before the digest await", async () => {
    const next = copy();
    const original = await context();
    const capturedRaw = JSON.stringify(next);
    const inFlight = derive("personal", capturedRaw);
    required(next.protection).vaultId += "_after-capture";
    expect(await inFlight).toEqual(original);
  });
  it("separates two genuine owners under the same tomb name", async () => {
    const other = await createVault(PASSWORD);
    const m = migrateLegacyHeaderToManifest({
      header: other.header,
      passkeyRpId: "owner.example.invalid",
    }).manifest;
    const second = {
      ...other.header,
      protection: await sealAuthenticatedManifest(other.rawVaultKey, m),
    };
    await verifyManifestAuth(other.rawVaultKey, second.protection);
    const a = await context();
    const b = await context(second);
    expect(b.vaultId).not.toBe(a.vaultId);
    expect(b.generationSha256).not.toBe(a.generationSha256);
    expect(await derive("prj_other", JSON.stringify(header))).not.toEqual(a);
  });
  it("invalidates a same-key password replacement and its old-wrap restore", async () => {
    const a = await context();
    const next = await modern(
      await rewrapVaultKey(
        header,
        PASSWORD,
        "context replacement primary 83062",
      ),
    );
    expect(
      await unwrapRawVaultKeyFromPassword(
        next,
        "context replacement primary 83062",
      ),
    ).toEqual(rawRoot);
    await verifyManifestAuth(rawRoot, required(next.protection));
    const b = await context(next);
    expect(b.vaultId).toBe(a.vaultId);
    expect(b.rootKeyId).toBe(a.rootKeyId);
    expect(b.rootEpoch).toBe(a.rootEpoch);
    expect(b.generationSha256).not.toBe(a.generationSha256);
    expect((await context(copy())).generationSha256).toBe(a.generationSha256);
  }, 30000);
  it("invalidates same-root factor replacement using actual new sealed metadata", async () => {
    const a = await context();
    const next = copy();
    required(next.unlocks).totp = await sealTotpSecret(key, "KRSXG5DSNFXGOIDB");
    expect((await context(await modern(next))).generationSha256).not.toBe(
      a.generationSha256,
    );
  });
  it("includes real nonlegacy recovery-protector capsules and their public metadata", async () => {
    const m = required(header.protection);
    const enrolled = await enrollRecoveryKey({
      rootKey: rawRoot,
      context: {
        vaultId: m.vaultId,
        rootKeyId: m.rootKeyId,
        rootEpoch: m.rootEpoch,
        protectorId: "pending",
        purpose: m.purpose,
      },
    });
    expect(
      await openWithRecoveryKey({
        context: {
          vaultId: m.vaultId,
          rootKeyId: m.rootKeyId,
          rootEpoch: m.rootEpoch,
          protectorId: enrolled.record.protectorId,
          purpose: m.purpose,
        },
        record: enrolled.record,
        secretB64: enrolled.secretB64,
      }),
    ).toEqual(rawRoot);
    const { authB64: _tag, ...unsigned } = m;
    const next = {
      ...header,
      protection: await sealAuthenticatedManifest(rawRoot, {
        ...unsigned,
        records: [...unsigned.records, enrolled.record],
        revision: unsigned.revision + 1,
      }),
    };
    await verifyManifestAuth(rawRoot, next.protection);
    expect((await context(next)).generationSha256).not.toBe(
      (await context()).generationSha256,
    );
    expect(encode(await context(next))).not.toContain(enrolled.secretB64);
  });
  it.each([
    "vaultId",
    "rootKeyId",
    "rootEpoch",
    "revision",
    "preferredProtectorId",
  ] as const)("invalidates authenticated %s publication", async (field) => {
    const next = copy();
    const { authB64: _tag, ...unsigned } = required(next.protection);
    const updated = { ...unsigned };
    if (field === "rootEpoch" || field === "revision") updated[field] += 1;
    else if (field === "preferredProtectorId")
      updated.preferredProtectorId = required(updated.records[0]).protectorId;
    else updated[field] += "_replacement";
    next.protection = await sealAuthenticatedManifest(rawRoot, updated);
    await verifyManifestAuth(rawRoot, next.protection);
    expect((await context(next)).generationSha256).not.toBe(
      (await context()).generationSha256,
    );
  });
  it("does not turn a correctly shaped forged manifest tag into an authentication proof", async () => {
    const next = copy();
    required(next.protection).authB64 = btoa("x".repeat(32));
    await expect(
      verifyManifestAuth(rawRoot, required(next.protection)),
    ).rejects.toThrow();
    expect((await context(next)).generationSha256).not.toBe(
      (await context()).generationSha256,
    );
  });
  it("refuses ambiguous protector IDs, dangling preferences and conflicting PRF aliases", async () => {
    const m = required(header.protection);
    const alias = {
      ...required(required(header.unlocks).passkey),
      userIdB64: btoa("other-user"),
    };
    for (const input of [
      {
        ...header,
        protection: { ...m, records: [...m.records, m.records[0]] },
      },
      { ...header, protection: { ...m, preferredProtectorId: "missing" } },
      { ...header, unlocks: { ...header.unlocks, passkey: alias } },
      {
        ...header,
        unlocks: {
          ...header.unlocks,
          passkeys: [
            required(header.unlocks).passkey,
            required(header.unlocks).passkey,
          ],
        },
      },
      { ...header, wrap: { ...header.wrap, ctB64: btoa("a".repeat(48)) } },
    ])
      await expect(derive("personal", JSON.stringify(input))).rejects.toThrow(
        "context is unavailable",
      );
  });
});
