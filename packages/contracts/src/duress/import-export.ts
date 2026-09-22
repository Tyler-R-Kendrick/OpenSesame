import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type DryRunDiff, dryRunDuressPolicy } from "./compiler.js";
import { policyDigest } from "./digest.js";
import type { CompilerCatalog } from "./evidence.js";
import { type PolicyDocument, PolicyDocumentSchema } from "./policy.js";

export type DuressWireFormat = "json" | "yaml";

/** Keys that must never appear in exported policy documents. */
const SECRET_KEY_PATTERN =
  /(secret|password|(^|[_-])pin($|[_-])|(^|[_-])code($|[_-])|prf|credential|token|verifier|seed|mnemonic|passphrase)/i;

export type ImportPreview = {
  document: PolicyDocument;
  policyDigest: string;
  /** Always false — import never arms. */
  armed: false;
  /** Always false — import never clears an active enrollment. */
  cleared: false;
  strippedSecretKeys: string[];
  dryRun: DryRunDiff;
};

function asBoundary(
  value: string | PolicyDocument | JsonObject,
): BoundaryValue {
  return overlapCast(value);
}

function stripSecrets(
  value: BoundaryValue,
  path: string,
  found: string[],
): BoundaryValue {
  if (Array.isArray(value)) {
    return value.map((item, i) => stripSecrets(item, `${path}[${i}]`, found));
  }
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const childPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) {
      found.push(childPath);
      continue;
    }
    if (child === undefined) continue;
    // SAFETY: stripSecrets preserves JSON structure for allowed keys at each depth.
    out[key] = overlapCast(stripSecrets(child, childPath, found));
  }
  return out;
}

export function parseDuressWire(
  raw: string,
  format: DuressWireFormat,
): BoundaryValue {
  if (format === "json") {
    return overlapCast(JSON.parse(raw));
  }
  return overlapCast(parseYaml(raw));
}

export function serializeDuressPolicy(
  document: PolicyDocument,
  format: DuressWireFormat,
): string {
  const strippedKeys: string[] = [];
  const cleaned = stripSecrets(asBoundary(document), "", strippedKeys);
  if (strippedKeys.length > 0) {
    throw new Error(
      `Refusing to export secret-bearing keys: ${strippedKeys.join(", ")}`,
    );
  }
  if (format === "json") {
    return `${JSON.stringify(cleaned, null, 2)}\n`;
  }
  return stringifyYaml(cleaned);
}

/**
 * Import/preview: validates schema, strips secrets, dry-runs against catalog.
 * Never arms triggers and never clears enrollment state.
 */
export function importDuressPolicyPreview(
  raw: string,
  format: DuressWireFormat,
  catalog: CompilerCatalog,
): ImportPreview {
  const parsed = parseDuressWire(raw, format);
  const strippedKeys: string[] = [];
  const cleaned = stripSecrets(parsed, "", strippedKeys);
  const document = PolicyDocumentSchema.parse(cleaned);
  const dryRun = dryRunDuressPolicy(document, catalog, {
    ownerConsent: false,
    rehearsalPassed: false,
    durableStorage: catalog.durableStorage,
    enrolledTriggers: false,
  });
  return {
    document,
    policyDigest: policyDigest(document),
    armed: false,
    cleared: false,
    strippedSecretKeys: strippedKeys,
    dryRun,
  };
}

export type PolicyConfigDiff = {
  policyIdChanged: boolean;
  revisionDelta: number;
  enabledChanged: boolean;
  addedProfileIds: string[];
  removedProfileIds: string[];
  changedProfileIds: string[];
  wouldArm: false;
  wouldClear: false;
  beforeDigest: string;
  afterDigest: string;
};

export function diffDuressPolicies(
  before: PolicyDocument,
  after: PolicyDocument,
): PolicyConfigDiff {
  const beforeIds = new Set(before.profiles.map((p) => p.profileId));
  const afterIds = new Set(after.profiles.map((p) => p.profileId));
  const addedProfileIds = [...afterIds].filter((id) => !beforeIds.has(id));
  const removedProfileIds = [...beforeIds].filter((id) => !afterIds.has(id));
  const changedProfileIds: string[] = [];
  for (const profile of after.profiles) {
    if (!beforeIds.has(profile.profileId)) continue;
    const prior = before.profiles.find(
      (p) => p.profileId === profile.profileId,
    );
    if (!prior) continue;
    if (JSON.stringify(prior) !== JSON.stringify(profile)) {
      changedProfileIds.push(profile.profileId);
    }
  }
  return {
    policyIdChanged: before.policyId !== after.policyId,
    revisionDelta: after.revision - before.revision,
    enabledChanged: before.enabled !== after.enabled,
    addedProfileIds,
    removedProfileIds,
    changedProfileIds,
    wouldArm: false,
    wouldClear: false,
    beforeDigest: policyDigest(before),
    afterDigest: policyDigest(after),
  };
}

export function roundTripDuressPolicy(
  document: PolicyDocument,
  format: DuressWireFormat,
): PolicyDocument {
  const serialized = serializeDuressPolicy(document, format);
  const reparsed = parseDuressWire(serialized, format);
  return PolicyDocumentSchema.parse(reparsed);
}

/** @deprecated internal helper retained for tests */
export function assertString(value: BoundaryValue): string {
  if (!isString(value)) throw new Error("expected string");
  return value;
}
