import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/** Inactive Pages metadata parser. Typed public data establishes no owner authority. */
import type {
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import { z } from "zod";
import { assertUnambiguousJson } from "./json-preflight.js";
import { assertPagesHeaderIntegerProfile } from "./pages-header-integers.js";

export const MAX_RETIRED_CONTEXT_HEADER_BYTES = 65536;
const utf8 = new TextEncoder();
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (s) =>
        !/[\uD800-\uDFFF]/u.test(s) &&
        utf8.encode(s).length <= max &&
        !hasControlCharacters(s),
    );
const id = text(256);
const contextKey = text(256);
const contextValue = text(2048);
// z.record discards own __proto__ keys; authenticated metadata must retain them.
const metadataMap = z.custom<Record<string, string>>((value) => {
  const input: BoundaryValue = overlapCast(value);
  if (!isJsonObject(input)) return false;
  const entries = Object.entries(input);
  return (
    entries.length <= 64 &&
    entries.every(
      ([key, entry]) =>
        contextKey.safeParse(key).success &&
        contextValue.safeParse(entry).success,
    )
  );
});
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.string().max(64).datetime();
const b64 = (minBytes: number, maxBytes: number) =>
  z
    .string()
    .min(minBytes === 0 ? 0 : 4)
    .max(Math.ceil(maxBytes / 3) * 4)
    .refine((s) => {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          s,
        )
      )
        return false;
      const decoded = atob(s);
      return (
        decoded.length >= minBytes &&
        decoded.length <= maxBytes &&
        btoa(decoded) === s
      );
    });
const blob = z.strictObject({ ivB64: b64(12, 12), ctB64: b64(16, 32768) });
const rootWrap = blob.extend({ ctB64: b64(48, 48) });
const kdfIterations = z.number().int().min(600000).max(10000000);
const kdf = z.strictObject({
  alg: z.literal("PBKDF2-SHA256"),
  saltB64: b64(16, 16),
  iterations: kdfIterations,
});
const evidence = z.strictObject({
  kind: z.enum([
    "contract",
    "software-roundtrip",
    "browser",
    "hardware",
    "cloud-live",
  ]),
  implementationVersion: text(256),
  testedAt: date,
  evidenceRef: text(2048),
});
const base = z.strictObject({
  protectorId: id,
  proofStatus: z.enum(["verified", "untested", "stale"]),
  lastEvidence: evidence.optional(),
});
const record = z.discriminatedUnion("kind", [
  base.extend({
    kind: z.literal("password"),
    legacy: z.literal(true),
    kdf,
    wrap: rootWrap,
  }),
  base.extend({
    kind: z.literal("pin"),
    legacy: z.literal(true),
    saltB64: b64(16, 16),
    iterations: kdfIterations,
    wrap: rootWrap,
  }),
  base.extend({
    kind: z.literal("webauthn-prf"),
    legacy: z.boolean(),
    credentialIdB64: b64(1, 1024),
    rpId: text(253),
    saltB64: b64(32, 32),
    wrap: rootWrap,
    userVerification: z.enum(["required", "preferred", "discouraged"]),
  }),
  base.extend({
    kind: z.literal("device-local"),
    mechanism: text(256),
    wrap: blob,
  }),
  base.extend({
    kind: z.literal("age-recipient"),
    recipients: z.array(text(2048)).min(1).max(64),
    capsuleAgeB64: b64(1, 32768),
  }),
  base.extend({
    kind: z.literal("age-webauthn"),
    recipient: text(2048),
    capsuleAgeB64: b64(1, 32768),
  }),
  base.extend({
    kind: z.literal("yubikey-piv-age"),
    recipient: text(2048),
    serialHint: text(256).optional(),
    capsuleAgeB64: b64(1, 32768),
  }),
  base.extend({
    kind: z.literal("recovery-key"),
    wrap: blob,
    fingerprintB64: b64(8, 8),
  }),
  base.extend({
    kind: z.literal("aws-kms"),
    keyArn: text(2048),
    region: text(256),
    connectionId: id,
    connectionConfigVersion: text(256),
    wrappedSecretB64: b64(1, 32768),
    localCapsule: blob,
    encryptionContext: metadataMap,
  }),
  base.extend({
    kind: z.literal("azure-key-vault-keys"),
    versionedKeyId: text(2048),
    algorithm: z.literal("RSA-OAEP-256"),
    connectionId: id,
    connectionConfigVersion: text(256),
    tenantId: id,
    wrappedSecretB64: b64(1, 32768),
    localCapsule: blob,
  }),
  base.extend({
    kind: z.literal("gcp-kms"),
    keyName: text(2048),
    keyVersionName: text(2048).optional(),
    connectionId: id,
    connectionConfigVersion: text(256),
    wrappedSecretB64: b64(1, 32768),
    localCapsule: blob,
    aadB64: b64(1, 32768),
  }),
]);
const gates = z.strictObject({
  totpEnrolled: z.boolean(),
  emailEnrolled: z.boolean(),
  smsEnrolled: z.boolean(),
  recoveryCodesEnrolled: z.boolean(),
});
const manifest = z.strictObject({
  schemaVersion: z.literal(1),
  vaultId: id,
  rootKeyId: id,
  rootEpoch: integer,
  revision: integer,
  purpose: z.literal("human-vault-root"),
  records: z.array(record).min(1).max(64),
  preferredProtectorId: id.optional(),
  legacyGates: gates,
  factorConfiguration: z
    .strictObject({ version: z.literal(1), digestB64: b64(32, 32) })
    .optional(),
  authB64: b64(32, 32),
});
const passkey = z.strictObject({
  credentialIdB64: b64(1, 1024),
  userIdB64: b64(0, 64),
  prfSaltB64: b64(32, 32),
  wrap: rootWrap,
});
const remote = z.strictObject({ toWrap: blob, since: date });
const unlocks = z.strictObject({
  pin: z.strictObject({ kdf, wrap: rootWrap }).optional(),
  passkey: passkey.optional(),
  passkeys: z.array(passkey).max(64).optional(),
  totp: z
    .strictObject({
      secretWrap: blob,
      digits: z.literal(6),
      period: z.literal(30),
      selfItemId: id.optional(),
    })
    .optional(),
  email: remote.optional(),
  sms: remote.optional(),
  recovery: z
    .strictObject({
      codesWrap: blob,
      total: z.number().int().min(1).max(100),
      since: date,
    })
    .optional(),
});
const headerSchema = z.strictObject({
  v: z.literal(1),
  createdAt: date,
  hint: z
    .string()
    .max(4096)
    .refine((s) => !/[\uD800-\uDFFF]/u.test(s) && utf8.encode(s).length <= 4096)
    .optional(),
  kdf: kdf.optional(),
  wrap: rootWrap.optional(),
  unlocks: unlocks.optional(),
  bodyRev: integer.optional(),
  protection: manifest,
});

function unavailable(): never {
  throw new Error("Retired credential context is unavailable.");
}
type PublicHeader = z.infer<typeof headerSchema>;
function sameWrap(
  a: z.infer<typeof blob>,
  b: z.infer<typeof blob> | undefined,
): boolean {
  return a.ivB64 === b?.ivB64 && a.ctB64 === b?.ctB64;
}
function consistentManifest(header: PublicHeader): void {
  const m = header.protection;
  if (new Set(m.records.map((r) => r.protectorId)).size !== m.records.length)
    unavailable();
  if (
    m.preferredProtectorId &&
    !m.records.some((r) => r.protectorId === m.preferredProtectorId)
  )
    unavailable();
  consistentGates(header);
}
function consistentGates(header: PublicHeader): void {
  const m = header.protection;
  const u = header.unlocks;
  if (
    m.legacyGates.totpEnrolled !== (u?.totp !== undefined) ||
    m.legacyGates.emailEnrolled !== (u?.email !== undefined) ||
    m.legacyGates.smsEnrolled !== (u?.sms !== undefined) ||
    m.legacyGates.recoveryCodesEnrolled !== (u?.recovery !== undefined)
  )
    unavailable();
  if (u?.recovery && !u.totp && !u.email && !u.sms) unavailable();
}
function consistentPrimaries(header: PublicHeader): void {
  consistentPassword(header);
  consistentPin(header);
}
function consistentPassword(header: PublicHeader): void {
  const m = header.protection;
  if ((header.kdf !== undefined) !== (header.wrap !== undefined)) unavailable();
  const passwords = m.records.filter((r) => r.kind === "password");
  if (passwords.length !== (header.wrap ? 1 : 0)) unavailable();
  if (
    header.wrap &&
    (header.kdf?.saltB64 !== passwords[0]?.kdf.saltB64 ||
      header.kdf?.iterations !== passwords[0]?.kdf.iterations ||
      !sameWrap(header.wrap, passwords[0]?.wrap))
  )
    unavailable();
}
function consistentPin(header: PublicHeader): void {
  const m = header.protection;
  const u = header.unlocks;
  const pins = m.records.filter((r) => r.kind === "pin");
  if (pins.length !== (u?.pin ? 1 : 0)) unavailable();
  if (
    u?.pin &&
    (u.pin.kdf.saltB64 !== pins[0]?.saltB64 ||
      u.pin.kdf.iterations !== pins[0]?.iterations ||
      !sameWrap(u.pin.wrap, pins[0]?.wrap))
  )
    unavailable();
}
function consistentPasskeys(header: PublicHeader): void {
  const m = header.protection;
  const all = consistentLegacyPasskeys(header);
  const prfs = m.records.filter((r) => r.kind === "webauthn-prf");
  if (new Set(prfs.map((r) => r.credentialIdB64)).size !== prfs.length)
    unavailable();
  if (
    prfs.some(
      (p) =>
        p.legacy &&
        !all.some((row) => row.credentialIdB64 === p.credentialIdB64),
    )
  )
    unavailable();
  for (const row of all) {
    const p = prfs.find((r) => r.credentialIdB64 === row.credentialIdB64);
    if (!p || p.saltB64 !== row.prfSaltB64 || !sameWrap(p.wrap, row.wrap))
      unavailable();
  }
}
function consistentLegacyPasskeys(
  header: PublicHeader,
): z.infer<typeof passkey>[] {
  const u = header.unlocks;
  const rows = u?.passkeys ?? [];
  if (new Set(rows.map((r) => r.credentialIdB64)).size !== rows.length)
    unavailable();
  const legacy = u?.passkey;
  const same = rows.find((r) => r.credentialIdB64 === legacy?.credentialIdB64);
  if (
    same &&
    legacy &&
    (same.userIdB64 !== legacy.userIdB64 ||
      same.prfSaltB64 !== legacy.prfSaltB64 ||
      !sameWrap(same.wrap, legacy.wrap))
  )
    unavailable();
  return legacy && !same ? [legacy, ...rows] : rows;
}

/** Raw lexical/resource refusal precedes document parsing and cloning. No MAC/factor verification. */
export function readPagesRetiredCredentialHeader(
  raw: string,
): VaultHeader & { protection: RootProtectionManifest } {
  try {
    if (!isString(raw)) unavailable();
    assertUnambiguousJson(raw, MAX_RETIRED_CONTEXT_HEADER_BYTES);
    assertPagesHeaderIntegerProfile(raw);
    const header = headerSchema.parse(JSON.parse(raw));
    consistentManifest(header);
    consistentPrimaries(header);
    consistentPasskeys(header);
    return header;
  } catch {
    return unavailable();
  }
}
