import {
  type RootProtectionManifest,
  type VaultHeader,
  assertFactorConfigurationBinding,
  bytesToB64,
  createVault,
  parseFactorConfigurationBinding,
  prepareFactorConfigurationBinding,
  sealJson,
} from "@opensesame/vault-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openText, sealText } from "../unlock-factor-crypto.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";
import { parseRootProtectionManifest } from "./parse.js";

let root: Uint8Array;
let key: CryptoKey;
let enrolled: VaultHeader;
const SINCE = "2026-10-08T00:00:00.000Z";

function manifest(header: VaultHeader): RootProtectionManifest {
  if (!header.protection) throw new Error("fixture manifest missing");
  return header.protection;
}

/** Test fixture signing, never an enrollment authorization or production publisher. */
async function bind(header: VaultHeader): Promise<VaultHeader> {
  const factorConfiguration = await prepareFactorConfigurationBinding(header);
  const protection = await sealAuthenticatedManifest(root, {
    ...manifestWithoutAuth(manifest(header)),
    factorConfiguration,
  });
  return { ...header, protection };
}

beforeAll(async () => {
  const actual = await createVault("isolated binding fixture password");
  root = actual.rawVaultKey;
  key = actual.vaultKey;
  if (!actual.header.kdf || !actual.header.wrap)
    throw new Error("fixture password missing");
  const header: VaultHeader = {
    ...actual.header,
    unlocks: {
      totp: {
        secretWrap: await sealText(key, "JBSWY3DPEHPK3PXP"),
        digits: 6,
        period: 30,
        selfItemId: "totp-fixture",
      },
      email: {
        toWrap: await sealText(key, "owner@example.invalid"),
        since: SINCE,
      },
      sms: { toWrap: await sealText(key, "+15550000000"), since: SINCE },
      recovery: {
        codesWrap: await sealJson(key, { codes: ["aaaa-bbbb"], used: [false] }),
        total: 1,
        since: SINCE,
      },
    },
    protection: {
      schemaVersion: 1,
      vaultId: "binding-fixture-vault",
      rootKeyId: "binding-fixture-root",
      rootEpoch: 0,
      revision: 1,
      purpose: "human-vault-root",
      records: [
        {
          kind: "password",
          protectorId: "fixture-password",
          legacy: true,
          kdf: actual.header.kdf,
          wrap: actual.header.wrap,
          proofStatus: "verified",
        },
      ],
      legacyGates: {
        totpEnrolled: true,
        emailEnrolled: true,
        smsEnrolled: true,
        recoveryCodesEnrolled: true,
      },
    },
  };
  enrolled = await bind(header);
});

afterAll(() => root.fill(0));

it("retains the exact optional binding through the real schema parser and genuine manifest MAC", async () => {
  const parsed = parseRootProtectionManifest(
    JSON.stringify(manifest(enrolled)),
  );
  expect(parsed).toEqual(manifest(enrolled));
  await expect(verifyManifestAuth(root, parsed)).resolves.toBeUndefined();
  await expect(
    assertFactorConfigurationBinding({ ...enrolled, protection: parsed }),
  ).resolves.toBeUndefined();
  expect(parsed.records).toEqual(manifest(enrolled).records);
  expect(parsed.purpose).toBe("human-vault-root");
});

it("rejects digest substitution with the actual root-derived MAC", async () => {
  const altered = structuredClone(manifest(enrolled));
  altered.factorConfiguration = {
    version: 1,
    digestB64: bytesToB64(new Uint8Array(32)),
  };
  await expect(verifyManifestAuth(root, altered)).rejects.toMatchObject({
    code: "manifest_auth_failed",
  });
});

it("keeps legacy manifests readable while refusing strict unbound admission", async () => {
  const unsigned = manifestWithoutAuth(manifest(enrolled));
  expect(Reflect.deleteProperty(unsigned, "factorConfiguration")).toBe(true);
  const legacy = await sealAuthenticatedManifest(root, unsigned);
  const parsed = parseRootProtectionManifest(JSON.stringify(legacy));
  await expect(verifyManifestAuth(root, parsed)).resolves.toBeUndefined();
  await expect(
    assertFactorConfigurationBinding({ ...enrolled, protection: parsed }),
  ).rejects.toThrow(/binding/);
});

it("authenticates explicit absence for all four gates and refuses added configuration", async () => {
  const absent = await bind({
    ...enrolled,
    unlocks: undefined,
    protection: {
      ...manifest(enrolled),
      legacyGates: {
        totpEnrolled: false,
        emailEnrolled: false,
        smsEnrolled: false,
        recoveryCodesEnrolled: false,
      },
    },
  });
  await expect(
    verifyManifestAuth(root, manifest(absent)),
  ).resolves.toBeUndefined();
  await expect(
    assertFactorConfigurationBinding(absent),
  ).resolves.toBeUndefined();
  // Public v1 canonical protocol vector: context above, four false flags/four nulls.
  expect(manifest(absent).factorConfiguration?.digestB64).toBe(
    "rLx/7/0VvgHKUIRnJvoyXPYn4UBTlBkVRPIOknNMRkA=",
  );
  const email = enrolled.unlocks?.email;
  if (!email) throw new Error("fixture email missing");
  const added = { ...absent, unlocks: { email } };
  await expect(assertFactorConfigurationBinding(added)).rejects.toThrow(
    /required gates/,
  );
});

it("refuses missing authenticated gate flags and malformed sealed factor data", async () => {
  const missing = structuredClone(enrolled);
  const gates = manifest(missing).legacyGates;
  if (!gates) throw new Error("fixture gate flags missing");
  expect(Reflect.deleteProperty(gates, "totpEnrolled")).toBe(true);
  await expect(prepareFactorConfigurationBinding(missing)).rejects.toThrow(
    /missing/,
  );
  const damaged = structuredClone(enrolled);
  if (!damaged.unlocks?.totp) throw new Error("fixture TOTP missing");
  damaged.unlocks.totp.secretWrap.ctB64 = bytesToB64(new Uint8Array(15));
  await expect(assertFactorConfigurationBinding(damaged)).rejects.toThrow(
    /ciphertext size/,
  );
});

it("refuses authentic same-root old ciphertext replay into a new bound configuration", async () => {
  const original = enrolled.unlocks?.totp;
  if (!original) throw new Error("fixture TOTP missing");
  const next = await bind({
    ...enrolled,
    unlocks: {
      ...enrolled.unlocks,
      totp: {
        ...original,
        secretWrap: await sealText(key, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
      },
    },
    protection: { ...manifest(enrolled), revision: 2 },
  });
  await expect(
    verifyManifestAuth(root, manifest(next)),
  ).resolves.toBeUndefined();
  await expect(assertFactorConfigurationBinding(next)).resolves.toBeUndefined();
  await expect(openText(key, original.secretWrap)).resolves.toBe(
    "JBSWY3DPEHPK3PXP",
  );
  const replay = { ...next, unlocks: { ...next.unlocks, totp: original } };
  await expect(
    verifyManifestAuth(root, manifest(replay)),
  ).resolves.toBeUndefined();
  await expect(assertFactorConfigurationBinding(replay)).rejects.toThrow(
    /binding mismatch/,
  );
});

for (const field of ["totp", "email", "sms", "recovery"] as const) {
  it(`refuses removal of required ${field} while the original manifest MAC remains valid`, async () => {
    const altered = structuredClone(enrolled);
    if (!altered.unlocks) throw new Error("fixture unlocks missing");
    delete altered.unlocks[field];
    await expect(
      verifyManifestAuth(root, manifest(altered)),
    ).resolves.toBeUndefined();
    await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
      /required gates/,
    );
  });
}

it("distinguishes channel substitution and selected item/count metadata", async () => {
  const exchanged = structuredClone(enrolled);
  const email = exchanged.unlocks?.email;
  const sms = exchanged.unlocks?.sms;
  if (!email || !sms || !exchanged.unlocks)
    throw new Error("fixture channels missing");
  exchanged.unlocks.email = sms;
  exchanged.unlocks.sms = email;
  await expect(assertFactorConfigurationBinding(exchanged)).rejects.toThrow(
    /binding mismatch/,
  );
  const altered = structuredClone(enrolled);
  if (!altered.unlocks?.totp || !altered.unlocks.recovery)
    throw new Error("fixture factors missing");
  altered.unlocks.totp.selfItemId = "substituted-item";
  await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
    /binding mismatch/,
  );
  const originalTotp = enrolled.unlocks?.totp;
  if (!originalTotp) throw new Error("fixture original TOTP missing");
  altered.unlocks.totp = structuredClone(originalTotp);
  altered.unlocks.recovery.total = 2;
  await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
    /binding mismatch/,
  );
});

for (const field of ["email", "sms", "recovery"] as const) {
  it(`binds the selected ${field} enrollment timestamp`, async () => {
    const altered = structuredClone(enrolled);
    const factor = altered.unlocks?.[field];
    if (!factor) throw new Error("fixture dated factor missing");
    factor.since = "2026-10-09T00:00:00.000Z";
    await expect(
      verifyManifestAuth(root, manifest(altered)),
    ).resolves.toBeUndefined();
    await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
      /binding mismatch/,
    );
  });
}

for (const [field, value] of [
  ["digits", 8],
  ["period", 60],
] as const) {
  it(`refuses unsupported runtime TOTP ${field} without a missing-factor fallback`, async () => {
    const altered = structuredClone(enrolled);
    const factor = altered.unlocks?.totp;
    if (!factor) throw new Error("fixture TOTP missing");
    expect(Reflect.set(factor, field, value)).toBe(true);
    await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
      /unsupported TOTP options/,
    );
  });
}

it("binds recovery ciphertext generation and refuses an authentic unspent-set replay", async () => {
  const previous = enrolled.unlocks?.recovery;
  if (!previous) throw new Error("fixture recovery missing");
  const current = await bind({
    ...enrolled,
    unlocks: {
      ...enrolled.unlocks,
      recovery: {
        ...previous,
        codesWrap: await sealJson(key, { codes: ["aaaa-bbbb"], used: [true] }),
      },
    },
    protection: { ...manifest(enrolled), revision: 2 },
  });
  await expect(
    assertFactorConfigurationBinding(current),
  ).resolves.toBeUndefined();
  const replay = {
    ...current,
    unlocks: { ...current.unlocks, recovery: previous },
  };
  await expect(
    verifyManifestAuth(root, manifest(replay)),
  ).resolves.toBeUndefined();
  await expect(assertFactorConfigurationBinding(replay)).rejects.toThrow(
    /binding mismatch/,
  );
});

for (const field of [
  "vaultId",
  "rootKeyId",
  "rootEpoch",
  "revision",
  "purpose",
] as const) {
  it(`binds the exact ${field} context even after a genuine independent MAC`, async () => {
    const altered = structuredClone(enrolled);
    const next = manifest(altered);
    if (field === "vaultId" || field === "rootKeyId") next[field] += "-other";
    else if (field === "purpose") next.purpose = "workload-root";
    else next[field] += 1;
    altered.protection = await sealAuthenticatedManifest(
      root,
      manifestWithoutAuth(next),
    );
    await expect(
      verifyManifestAuth(root, manifest(altered)),
    ).resolves.toBeUndefined();
    await expect(assertFactorConfigurationBinding(altered)).rejects.toThrow(
      /factor configuration/,
    );
  });
}

for (const malformed of [
  null,
  {},
  { version: 2, digestB64: bytesToB64(new Uint8Array(32)) },
  { version: 1, digestB64: "" },
  { version: 1, digestB64: bytesToB64(new Uint8Array(31)) },
  { version: 1, digestB64: bytesToB64(new Uint8Array(32)), extra: true },
]) {
  it("refuses malformed or unknown binding data without producing an absent result", () => {
    expect(() => parseFactorConfigurationBinding(malformed)).toThrow();
    const raw = { ...manifest(enrolled), factorConfiguration: malformed };
    expect(() => parseRootProtectionManifest(JSON.stringify(raw))).toThrow();
  });
}
