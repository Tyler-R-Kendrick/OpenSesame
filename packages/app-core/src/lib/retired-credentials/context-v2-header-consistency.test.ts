import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
import {
  type RootProtectionManifest,
  type VaultHeader,
  createVault,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "../vault/protection/manifest-auth.js";
import {
  unwrapVaultKeyWithPin,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPin,
  wrapVaultKeyWithPrf,
} from "../vault/unlock-factor-crypto.js";
import { readPagesRetiredCredentialHeader } from "./context-v2-header.js";

type Header = VaultHeader & { protection: RootProtectionManifest };
const password = "strict header genuine password control";
const pin = "48291037";
const prf = crypto.getRandomValues(new Uint8Array(32)).buffer;
let header: Header;
let root: Uint8Array;
function parse(input: Header | JsonObject) {
  return readPagesRetiredCredentialHeader(JSON.stringify(input));
}
function refuseChange(path: string[], value: BoundaryValue): void {
  const changed: JsonObject = JSON.parse(JSON.stringify(header));
  let target: JsonObject | JsonValue[] = changed;
  for (const key of path.slice(0, -1)) {
    const next: JsonValue | undefined = Array.isArray(target)
      ? target[Number(key)]
      : target[key];
    if (!isJsonObject(next) && !Array.isArray(next))
      throw new Error("Invalid test path");
    target = next;
  }
  const key = path.at(-1);
  if (!key || !isJsonObject(target)) throw new Error("Invalid test path");
  target[key] =
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  expect(() => parse(changed)).toThrow("context is unavailable");
}

beforeAll(async () => {
  const made = await createVault(password);
  root = made.rawVaultKey;
  if (!made.header.kdf || !made.header.wrap) throw new Error("Missing wrap");
  const pinRecord = await wrapVaultKeyWithPin(root, pin);
  const passkey = await wrapVaultKeyWithPrf(
    root,
    prf,
    crypto.getRandomValues(new Uint8Array(32)),
    new Uint8Array([1, 2, 3]).buffer,
    new Uint8Array([4, 5, 6]).buffer,
  );
  const protection = await sealAuthenticatedManifest(root, {
    schemaVersion: 1,
    vaultId: "strict-header-test-vault",
    rootKeyId: "strict-header-test-root",
    rootEpoch: 1,
    revision: 1,
    purpose: "human-vault-root",
    legacyGates: {
      totpEnrolled: false,
      emailEnrolled: false,
      smsEnrolled: false,
      recoveryCodesEnrolled: false,
    },
    records: [
      {
        kind: "password",
        protectorId: "pw",
        legacy: true,
        kdf: made.header.kdf,
        wrap: made.header.wrap,
        proofStatus: "verified",
      },
      {
        kind: "pin",
        protectorId: "pin",
        legacy: true,
        saltB64: pinRecord.kdf.saltB64,
        iterations: pinRecord.kdf.iterations,
        wrap: pinRecord.wrap,
        proofStatus: "verified",
      },
      {
        kind: "webauthn-prf",
        protectorId: "prf",
        legacy: true,
        credentialIdB64: passkey.credentialIdB64,
        rpId: "localhost",
        saltB64: passkey.prfSaltB64,
        wrap: passkey.wrap,
        userVerification: "required",
        proofStatus: "verified",
      },
    ],
  });
  header = {
    ...made.header,
    protection,
    unlocks: { pin: pinRecord, passkey, passkeys: [passkey] },
  };
}, 10000);

afterAll(() => {
  root?.fill(0);
  new Uint8Array(prf).fill(0);
});
describe("inactive header primary and physical gate consistency", () => {
  it("preserves genuine password, PIN, PRF wraps and manifest MAC", async () => {
    const parsed = parse(header);
    await verifyManifestAuth(root, parsed.protection);
    const pinRecord = parsed.unlocks?.pin;
    const passkey = parsed.unlocks?.passkey;
    if (!pinRecord || !passkey) throw new Error("Missing parsed primary");
    const opened = [
      await unwrapRawVaultKeyFromPassword(parsed, password),
      await unwrapVaultKeyWithPin(pinRecord, pin),
      await unwrapVaultKeyWithPrf(passkey, prf),
    ];
    for (const bytes of opened) {
      expect(bytes).toEqual(root);
      bytes.fill(0);
    }
  });
  it.each([
    ["kdf.saltB64", btoa("x".repeat(16))],
    ["kdf.iterations", 600001],
    ["wrap.ivB64", btoa("x".repeat(12))],
    ["wrap.ctB64", btoa("x".repeat(48))],
    ["unlocks.pin.kdf.saltB64", btoa("x".repeat(16))],
    ["unlocks.pin.kdf.iterations", 600001],
    ["unlocks.pin.wrap.ivB64", btoa("x".repeat(12))],
    ["unlocks.pin.wrap.ctB64", btoa("x".repeat(48))],
    ["kdf", undefined],
    ["wrap", undefined],
    ["unlocks.pin", undefined],
    ["unlocks.passkey.userIdB64", btoa("different-user")],
    ["unlocks.passkey.prfSaltB64", btoa("x".repeat(32))],
    ["unlocks.passkey.wrap.ivB64", btoa("x".repeat(12))],
    ["protection.records.2.saltB64", btoa("x".repeat(32))],
    ["protection.records.2.wrap.ivB64", btoa("x".repeat(12))],
    ["protection.records.2.credentialIdB64", btoa("absent-credential")],
  ] satisfies [string, BoundaryValue][])(
    "refuses inconsistent metadata at %s",
    (path, value) => {
      refuseChange(path.split("."), value);
    },
  );
  it.each(["password", "pin", "webauthn-prf"])(
    "refuses missing and duplicate %s records",
    (kind) => {
      const records = header.protection.records;
      const record = records.find((r) => r.kind === kind);
      if (!record) throw new Error("Missing primary fixture");
      refuseChange(
        ["protection", "records"],
        records.filter((r) => r.kind !== kind),
      );
      refuseChange(
        ["protection", "records"],
        [...records, { ...record, protectorId: "peer" }],
      );
    },
  );
  it("refuses duplicate passkey rows and orphan legacy PRF records", () => {
    const selected = header.unlocks?.passkey;
    if (!selected) throw new Error("Missing PRF fixture");
    refuseChange(["unlocks", "passkeys"], [selected, selected]);
    const changed = structuredClone(header);
    changed.unlocks = { ...changed.unlocks, passkey: undefined, passkeys: [] };
    expect(() => parse(changed)).toThrow("context is unavailable");
  });
  it.each([
    ["totpEnrolled", "totp"],
    ["emailEnrolled", "email"],
    ["smsEnrolled", "sms"],
    ["recoveryCodesEnrolled", "recovery"],
  ] as const)("requires strict %s matching physical %s", (flag, field) => {
    const wrap = header.wrap;
    if (!wrap) throw new Error("Missing metadata wrap fixture");
    // Shape-only mutations do not establish enrolled factors or owner authority.
    const physical = {
      totp: { secretWrap: wrap, digits: 6 as const, period: 30 as const },
      email: { toWrap: wrap, since: header.createdAt },
      sms: { toWrap: wrap, since: header.createdAt },
      recovery: { codesWrap: wrap, total: 10, since: header.createdAt },
    };
    for (const value of [true, "false", 0, null, undefined])
      refuseChange(["protection", "legacyGates", flag], value);
    refuseChange(["unlocks", field], physical[field]);
    const changed = structuredClone(header);
    changed.unlocks = { ...changed.unlocks, ...physical };
    changed.protection.legacyGates = {
      totpEnrolled: true,
      emailEnrolled: true,
      smsEnrolled: true,
      recoveryCodesEnrolled: true,
    };
    expect(() => parse(changed)).not.toThrow();
    changed.protection.legacyGates[flag] = false;
    expect(() => parse(changed)).toThrow("context is unavailable");
  });
  it("refuses recovery without a configured second factor", () => {
    const wrap = header.wrap;
    if (!wrap) throw new Error("Missing metadata wrap fixture");
    const changed = structuredClone(header);
    changed.unlocks = {
      ...changed.unlocks,
      recovery: { codesWrap: wrap, total: 10, since: header.createdAt },
    };
    changed.protection.legacyGates = {
      ...header.protection.legacyGates,
      totpEnrolled: false,
      emailEnrolled: false,
      smsEnrolled: false,
      recoveryCodesEnrolled: true,
    };
    expect(() => parse(changed)).toThrow("context is unavailable");
  });
});
