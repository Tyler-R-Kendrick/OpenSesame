/** Data integrity only: digest preparation/comparison never grants enrollment. */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import { VaultCorruptError, type VaultHeader } from "./crypto.js";
import type { FactorConfigurationBinding } from "./protection-types.js";

const DOMAIN = "opensesame/vault/factor-configuration/v1";
const MAX_SEAL_BYTES = 64 * 1024;

function refuse(detail: string): never {
  throw new VaultCorruptError(`factor configuration: ${detail}`);
}

function object(
  value: BoundaryValue,
  keys: string[],
  label: string,
): JsonObject {
  if (!isJsonObject(value)) return refuse(`${label} is not an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    return refuse(`${label} has unsupported fields`);
  }
  return value;
}

function text(value: BoundaryValue, label: string, max = 256): string {
  if (!isString(value) || value.length === 0 || value.length > max) {
    return refuse(`${label} is invalid`);
  }
  return value;
}

function integer(value: BoundaryValue, label: string, min = 0): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < min) {
    return refuse(`${label} is invalid`);
  }
  return value;
}

function encoded(value: BoundaryValue, label: string, size?: number): string {
  const source = text(value, label, 2 * MAX_SEAL_BYTES);
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(source);
  } catch {
    return refuse(`${label} encoding is invalid`);
  }
  if (bytesToB64(bytes) !== source || bytes.length > MAX_SEAL_BYTES) {
    return refuse(`${label} encoding or size is invalid`);
  }
  if (size !== undefined ? bytes.length !== size : bytes.length < 16) {
    return refuse(`${label} size is invalid`);
  }
  return source;
}

function seal(value: BoundaryValue): JsonObject {
  const row = object(value, ["ivB64", "ctB64"], "seal");
  return {
    ivB64: encoded(row.ivB64, "IV", 12),
    ctB64: encoded(row.ctB64, "ciphertext"),
  };
}

function since(value: BoundaryValue): string {
  const source = text(value, "since", 64);
  const millis = Date.parse(source);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== source) {
    return refuse("since is not a canonical ISO timestamp");
  }
  return source;
}

function totp(value: BoundaryValue): JsonObject | null {
  if (value === undefined) return null;
  const row = object(
    value,
    ["secretWrap", "digits", "period", "selfItemId"],
    "TOTP",
  );
  if (row.digits !== 6 || row.period !== 30)
    return refuse("unsupported TOTP options");
  return {
    secretWrap: seal(row.secretWrap),
    digits: 6,
    period: 30,
    selfItemId:
      row.selfItemId === undefined ? null : text(row.selfItemId, "selfItemId"),
  };
}

function remote(value: BoundaryValue): JsonObject | null {
  if (value === undefined) return null;
  const row = object(value, ["toWrap", "since"], "remote channel");
  return { toWrap: seal(row.toWrap), since: since(row.since) };
}

function recovery(value: BoundaryValue): JsonObject | null {
  if (value === undefined) return null;
  const row = object(value, ["codesWrap", "total", "since"], "recovery");
  return {
    codesWrap: seal(row.codesWrap),
    total: integer(row.total, "recovery total", 1),
    since: since(row.since),
  };
}

function gateFlags(value: BoundaryValue): JsonObject {
  const names = [
    "totpEnrolled",
    "emailEnrolled",
    "smsEnrolled",
    "recoveryCodesEnrolled",
  ];
  const row = object(value, names, "required gates");
  const result: JsonObject = {};
  for (const name of names) {
    const flag = row[name];
    if (!isBoolean(flag)) return refuse(`required ${name} is missing`);
    result[name] = flag;
  }
  return result;
}

/** Fixed-field ordered JSON; explicit nulls encode every absent factor. */
function selectedBytes(header: VaultHeader): Uint8Array {
  const manifest = header.protection;
  if (
    header.v !== 1 ||
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.purpose !== "human-vault-root"
  ) {
    return refuse("a human-vault manifest is required");
  }
  if (header.unlocks !== undefined) {
    object(
      header.unlocks,
      ["passkey", "passkeys", "pin", "totp", "email", "sms", "recovery"],
      "unlocks",
    );
  }
  const gates = gateFlags(manifest.legacyGates);
  const factors = {
    totp: totp(header.unlocks?.totp),
    email: remote(header.unlocks?.email),
    sms: remote(header.unlocks?.sms),
    recovery: recovery(header.unlocks?.recovery),
  };
  const actual = [factors.totp, factors.email, factors.sms, factors.recovery];
  const declared = [
    gates.totpEnrolled,
    gates.emailEnrolled,
    gates.smsEnrolled,
    gates.recoveryCodesEnrolled,
  ];
  if (actual.some((factor, index) => (factor !== null) !== declared[index])) {
    return refuse("required gates disagree with enrolled configuration");
  }
  const payload = {
    vaultId: text(manifest.vaultId, "vaultId"),
    rootKeyId: text(manifest.rootKeyId, "rootKeyId"),
    rootEpoch: integer(manifest.rootEpoch, "rootEpoch"),
    revision: integer(manifest.revision, "revision"),
    purpose: "human-vault-root",
    gates,
    factors,
  };
  return new TextEncoder().encode(`${DOMAIN}\0${JSON.stringify(payload)}`);
}

export function parseFactorConfigurationBinding(
  value: BoundaryValue,
): FactorConfigurationBinding {
  const row = object(value, ["version", "digestB64"], "binding");
  if (row.version !== 1) return refuse("unsupported binding version");
  return { version: 1, digestB64: encoded(row.digestB64, "digest", 32) };
}

/** Unsigned data only. A trusted re-enrollment transaction must authorize MAC/publication. */
export async function prepareFactorConfigurationBinding(
  header: VaultHeader,
): Promise<FactorConfigurationBinding> {
  const bytes = selectedBytes(header);
  const digest = await crypto.subtle.digest("SHA-256", overlapCast(bytes));
  return { version: 1, digestB64: bytesToB64(new Uint8Array(digest)) };
}

/** Compare only; caller must first verify the actual manifest MAC and owner context. */
export async function assertFactorConfigurationBinding(
  header: VaultHeader,
): Promise<void> {
  const binding = parseFactorConfigurationBinding(
    header.protection?.factorConfiguration,
  );
  const expected = await prepareFactorConfigurationBinding(header);
  if (binding.digestB64 !== expected.digestB64)
    return refuse("binding mismatch");
}
