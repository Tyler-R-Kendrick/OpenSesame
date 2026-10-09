import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  type RootProtectionManifest,
  type VaultHeader,
  type VaultUnlocks,
  mintVaultKey,
} from "@opensesame/vault-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFreshOwnerFactorPolicy } from "./fresh-owner-factor-policy.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./protection/manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./protection/migrate-legacy.js";
import { mintRecoveryCodes } from "./recovery-codes.js";
import {
  sealText,
  sealTotpSecret,
  wrapVaultKeyWithPin,
} from "./unlock-methods.js";

const unavailable = "Fresh owner factor policy is unavailable.";
let raw: Uint8Array;
let enrolled: VaultUnlocks;

beforeAll(async () => {
  const minted = await mintVaultKey();
  raw = minted.rawVaultKey;
  enrolled = {
    pin: await wrapVaultKeyWithPin(raw, "75319842"),
    totp: await sealTotpSecret(minted.vaultKey, "JBSWY3DPEHPK3PXP"),
    email: {
      toWrap: await sealText(minted.vaultKey, "owner@example.invalid"),
      since: "2026-10-08T00:00:00.000Z",
    },
    sms: {
      toWrap: await sealText(minted.vaultKey, "+14155550142"),
      since: "2026-10-08T00:00:00.000Z",
    },
    recovery: (await mintRecoveryCodes(minted.vaultKey)).record,
  };
});
afterAll(() => raw?.fill(0));

function legacy(unlocks: VaultUnlocks): VaultHeader {
  return { v: 1, createdAt: "2026-10-08T00:00:00.000Z", unlocks };
}

async function authenticated(unlocks: VaultUnlocks): Promise<VaultHeader> {
  const header = legacy(unlocks);
  const { manifest } = migrateLegacyHeaderToManifest({
    header,
    vaultId: "vault-factor-policy",
    rootKeyId: "root-factor-policy",
    passkeyRpId: "owner.example.invalid",
  });
  const protection = await sealAuthenticatedManifest(raw, manifest);
  await verifyManifestAuth(raw, protection);
  return { ...header, protection };
}

function refused<Header>(header: Header): void {
  const input: BoundaryValue = overlapCast(header);
  expect(() => readFreshOwnerFactorPolicy(input)).toThrow(unavailable);
}

function policyOf(header: VaultHeader) {
  const input: BoundaryValue = overlapCast(header);
  return readFreshOwnerFactorPolicy(input);
}

function manifestOf(header: VaultHeader): RootProtectionManifest {
  const manifest = header.protection;
  if (!manifest) throw new Error("Genuine projected fixture is missing.");
  return manifest;
}

describe("fresh owner factor policy metadata", () => {
  it("retains the actual alternative steps and recovery without an auth verdict", async () => {
    const header = await authenticated(enrolled);
    const policy = policyOf(header);
    expect(policy).toEqual({
      secondSteps: ["totp", "email", "sms"],
      recoveryCodesEnrolled: true,
    });
    expect(Object.keys(policy).sort()).toEqual([
      "recoveryCodesEnrolled",
      "secondSteps",
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.secondSteps)).toBe(true);
  });

  it("supports a genuine PIN-only projection and unprojected legacy policy", async () => {
    const unlocks = { pin: enrolled.pin };
    const header = await authenticated(unlocks);
    expect(policyOf(header)).toEqual({
      secondSteps: [],
      recoveryCodesEnrolled: false,
    });
    expect(policyOf(legacy(enrolled)).secondSteps).toEqual([
      "totp",
      "email",
      "sms",
    ]);
  });

  it.each(["totp", "email", "sms", "recovery"] as const)(
    "refuses removal of the header %s gate while its authenticated policy remains",
    async (field) => {
      const header = await authenticated(enrolled);
      const unlocks = { ...enrolled };
      delete unlocks[field];
      refused({ ...header, unlocks });
    },
  );

  it.each(["totp", "email", "sms", "recovery"] as const)(
    "refuses an added header %s gate absent from its authenticated policy",
    async (field) => {
      const unlocks = { ...enrolled };
      delete unlocks[field];
      const header = await authenticated(unlocks);
      refused({ ...header, unlocks: enrolled });
    },
  );

  it("refuses a genuinely authenticated workload manifest for human owner management", async () => {
    const header = await authenticated(enrolled);
    const { authB64: _previous, ...manifest } = manifestOf(header);
    const protection = await sealAuthenticatedManifest(raw, {
      ...manifest,
      purpose: "workload-root",
    });
    await verifyManifestAuth(raw, protection);
    refused({ ...header, protection });
  });

  it("does not reinterpret missing, malformed or unknown authenticated flags as false", async () => {
    const header = await authenticated({ pin: enrolled.pin });
    const protection = manifestOf(header);
    const gates = protection.legacyGates;
    if (!gates) throw new Error("Fixture gate declaration is missing.");
    for (const legacyGates of [
      undefined,
      null,
      [],
      {},
      Object.create(gates),
      { ...gates, totpEnrolled: "false" },
      { ...gates, emailEnrolled: 0 },
      { ...gates, smsEnrolled: null },
      { ...gates, recoveryCodesEnrolled: undefined },
      { ...gates, unknownFactorEnrolled: true },
    ]) {
      refused({ ...header, protection: { ...protection, legacyGates } });
    }
    refused({ ...header, protection: null });
    refused({
      ...header,
      protection: { ...protection, purpose: "future-root" },
    });
    refused({ ...header, protection: { ...protection, schemaVersion: 2 } });
    refused({
      ...header,
      protection: { ...protection, criticalExtensions: [] },
    });
  });

  it("does not mistake malformed or unknown header gates for an ungated primary", async () => {
    const header = await authenticated({ pin: enrolled.pin });
    for (const unlocks of [
      null,
      [],
      { pin: enrolled.pin, totp: null },
      { pin: enrolled.pin, email: false },
      { pin: enrolled.pin, sms: [] },
      { pin: enrolled.pin, recovery: "unsupported" },
      { pin: enrolled.pin, futureGate: {} },
    ]) {
      refused({ ...header, unlocks });
    }
    for (const invalid of [null, [], "header"]) refused(invalid);
  });

  it("refuses recovery without a second step, consistent with the actual store lifecycle", async () => {
    const unlocks = { pin: enrolled.pin, recovery: enrolled.recovery };
    refused(legacy(unlocks));
    refused(await authenticated(unlocks));
  });

  it("returns a detached requirement snapshot that cannot erase a captured factor", async () => {
    const header = await authenticated(enrolled);
    const policy = policyOf(header);
    header.unlocks = { pin: enrolled.pin };
    expect(policy.secondSteps).toEqual(["totp", "email", "sms"]);
    expect(policy.recoveryCodesEnrolled).toBe(true);
    refused(header);
  });
});
