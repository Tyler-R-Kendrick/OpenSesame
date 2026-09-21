/**
 * Bounded parse of root-protection manifests. Fail closed before crypto.
 * External JSON enters as BoundaryValue and is narrowed with os-domain guards.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { ProtectionError } from "./errors.js";
import {
  MANIFEST_SCHEMA_VERSION,
  MAX_MANIFEST_ENCODED_BYTES,
  MAX_PROTECTION_RECORDS,
  MAX_RECORD_ENCODED_BYTES,
} from "./limits.js";
import type {
  AuthenticatedLegacyGates,
  ProtectionPurpose,
  ProtectionRecord,
  RootProtectionManifest,
} from "./types.js";

const PROTECTOR_KINDS = new Set([
  "password",
  "pin",
  "webauthn-prf",
  "device-local",
  "age-recipient",
  "age-webauthn",
  "yubikey-piv-age",
  "recovery-key",
  "aws-kms",
  "azure-key-vault-keys",
  "gcp-kms",
]);

function requireNonEmptyString(value: BoundaryValue, field: string): string {
  if (!isString(value) || value.length === 0) {
    throw new ProtectionError(
      "malformed_encoding",
      `Field ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function requireNonNegInt(value: BoundaryValue, field: string): number {
  if (
    !isNumber(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ProtectionError(
      "malformed_encoding",
      `Field ${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

type DupKeyState = {
  stack: Array<Set<string>>;
  inString: boolean;
  escaping: boolean;
  pendingKey: boolean;
  keyBuf: string;
};

function consumeStringChar(state: DupKeyState, ch: string): void {
  if (state.escaping) {
    state.escaping = false;
    if (state.pendingKey) state.keyBuf += ch;
    return;
  }
  if (ch === "\\") {
    state.escaping = true;
    return;
  }
  if (ch === '"') {
    state.inString = false;
    return;
  }
  if (state.pendingKey) state.keyBuf += ch;
}

function commitPendingKey(state: DupKeyState): void {
  const top = state.stack[state.stack.length - 1];
  if (!top) {
    throw new ProtectionError(
      "malformed_encoding",
      "JSON object stack underflow.",
    );
  }
  if (top.has(state.keyBuf)) {
    throw new ProtectionError(
      "duplicate_json_key",
      `Duplicate JSON key "${state.keyBuf}".`,
    );
  }
  top.add(state.keyBuf);
  state.pendingKey = false;
  state.keyBuf = "";
}

function consumeStructureChar(state: DupKeyState, ch: string): void {
  if (ch === '"') {
    state.inString = true;
    if (state.stack.length > 0) {
      state.keyBuf = "";
      state.pendingKey = true;
    }
    return;
  }
  if (ch === "{") {
    state.stack.push(new Set());
    state.pendingKey = false;
    return;
  }
  if (ch === "}") {
    state.stack.pop();
    state.pendingKey = false;
    return;
  }
  if (ch === ":" && state.pendingKey && state.stack.length > 0) {
    commitPendingKey(state);
    return;
  }
  if (ch === ",") {
    state.pendingKey = false;
    state.keyBuf = "";
  }
}

function detectDuplicateJsonKeys(raw: string): void {
  const state: DupKeyState = {
    stack: [],
    inString: false,
    escaping: false,
    pendingKey: false,
    keyBuf: "",
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (state.inString) consumeStringChar(state, ch);
    else consumeStructureChar(state, ch);
  }
}

function parseRecord(raw: BoundaryValue, index: number): ProtectionRecord {
  const encoded = new TextEncoder().encode(JSON.stringify(raw));
  if (encoded.byteLength > MAX_RECORD_ENCODED_BYTES) {
    throw new ProtectionError(
      "oversized_record",
      `Protection record ${index} exceeds ${MAX_RECORD_ENCODED_BYTES} bytes.`,
    );
  }
  if (!isJsonObject(raw)) {
    throw new ProtectionError(
      "malformed_encoding",
      `Protection record ${index} must be an object.`,
    );
  }
  const kind = requireNonEmptyString(raw.kind, `records[${index}].kind`);
  if (!PROTECTOR_KINDS.has(kind)) {
    throw new ProtectionError(
      "unknown_critical_field",
      `Unknown protector kind "${kind}".`,
    );
  }
  const protectorId = requireNonEmptyString(
    raw.protectorId,
    `records[${index}].protectorId`,
  );
  const normalized: JsonObject = { ...raw, kind, protectorId };
  // SAFETY: PROTECTOR_KINDS.has validated kind; requireNonEmptyString checked protectorId.
  return normalized as ProtectionRecord;
}

function parsePurpose(value: BoundaryValue): ProtectionPurpose {
  const purpose = requireNonEmptyString(value, "purpose");
  if (purpose !== "human-vault-root" && purpose !== "workload-root") {
    throw new ProtectionError(
      "malformed_encoding",
      "purpose must be human-vault-root or workload-root.",
    );
  }
  return purpose;
}

function parseLegacyGates(
  value: BoundaryValue,
): AuthenticatedLegacyGates | undefined {
  if (!isJsonObject(value)) return undefined;
  return {
    totpEnrolled: value.totpEnrolled === true,
    emailEnrolled: value.emailEnrolled === true,
    smsEnrolled: value.smsEnrolled === true,
    recoveryCodesEnrolled: value.recoveryCodesEnrolled === true,
  };
}

export function parseRootProtectionManifest(
  input: string | Uint8Array,
): RootProtectionManifest {
  const bytes = isString(input) ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_MANIFEST_ENCODED_BYTES) {
    throw new ProtectionError(
      "oversized_manifest",
      `Manifest exceeds ${MAX_MANIFEST_ENCODED_BYTES} bytes.`,
    );
  }
  const text = isString(input) ? input : new TextDecoder().decode(input);
  detectDuplicateJsonKeys(text);
  let json: BoundaryValue;
  try {
    // SAFETY: JSON.parse yields a JSON value; BoundaryValue is that closed union.
    json = JSON.parse(text) as BoundaryValue;
  } catch {
    throw new ProtectionError(
      "malformed_encoding",
      "Manifest JSON could not be parsed.",
    );
  }
  if (!isJsonObject(json)) {
    throw new ProtectionError(
      "malformed_encoding",
      "Manifest must be a JSON object.",
    );
  }
  const schemaVersion = requireNonNegInt(json.schemaVersion, "schemaVersion");
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ProtectionError(
      "unsupported_version",
      `Unsupported manifest schemaVersion ${schemaVersion}.`,
    );
  }
  if (json.criticalExtensions !== undefined) {
    throw new ProtectionError(
      "unknown_critical_field",
      "Unknown criticalExtensions are not supported.",
    );
  }
  if (!Array.isArray(json.records)) {
    throw new ProtectionError(
      "malformed_encoding",
      "records must be an array.",
    );
  }
  if (json.records.length > MAX_PROTECTION_RECORDS) {
    throw new ProtectionError(
      "too_many_records",
      `At most ${MAX_PROTECTION_RECORDS} protection records are allowed.`,
    );
  }
  const records = json.records.map((entry, index) => parseRecord(entry, index));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.protectorId)) {
      throw new ProtectionError(
        "duplicate_protector_id",
        `Duplicate protectorId ${record.protectorId}.`,
      );
    }
    seen.add(record.protectorId);
  }
  const manifest: RootProtectionManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    vaultId: requireNonEmptyString(json.vaultId, "vaultId"),
    rootKeyId: requireNonEmptyString(json.rootKeyId, "rootKeyId"),
    rootEpoch: requireNonNegInt(json.rootEpoch, "rootEpoch"),
    revision: requireNonNegInt(json.revision, "revision"),
    purpose: parsePurpose(json.purpose),
    records,
  };
  if (isString(json.preferredProtectorId)) {
    manifest.preferredProtectorId = json.preferredProtectorId;
  }
  if (isString(json.authB64)) {
    manifest.authB64 = json.authB64;
  }
  const legacyGates = parseLegacyGates(json.legacyGates);
  if (legacyGates) {
    manifest.legacyGates = legacyGates;
  }
  return manifest;
}
