/**
 * YAML ↔ capability documents (S04).
 *
 * The Source view of `capabilities/*.yaml`. The guard here is stricter than
 * the general profile: the documents are short lists, so anything that makes
 * YAML clever — aliases, anchors, tags, duplicate keys, depth — is refused
 * before the package parsers see a value, and unknown fields are refused by
 * those parsers. Nothing here reads storage or the store.
 */

import type {
  Diagnostic,
  EffectivePlan,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  ParseResult,
  VaultCapabilitySelection,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type Node,
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import {
  MAX_CAPABILITY_DOCUMENT_BYTES,
  MAX_CAPABILITY_DOCUMENT_DEPTH,
} from "./capabilities-keys.js";
import {
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
} from "./capabilities-ports.js";
import type { ConfigDiagnostic } from "./types.js";

export type CapabilityDocumentResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function error(code: string, message: string): ConfigDiagnostic {
  return { severity: "error", code, message };
}

function fail<T>(code: string, message: string): CapabilityDocumentResult<T> {
  return { ok: false, diagnostics: [error(code, message)] };
}

function depthOf(node: BoundaryValue, depth: number): number {
  if (!isCollection(node)) return depth;
  let deepest = depth;
  for (const item of node.items) {
    const child: BoundaryValue = isPair(item)
      ? overlapCast(item.value)
      : overlapCast(item);
    deepest = Math.max(deepest, depthOf(child, depth + 1));
  }
  return deepest;
}

/** Explicit tags, anchors and aliases — every one a refusal. */
function cleverness(root: Node | null): ConfigDiagnostic | null {
  let found: ConfigDiagnostic | null = null;
  if (!root) return null;
  visit(root, (_key, node) => {
    if (found) return visit.BREAK;
    if (isAlias(node)) {
      found = error("alias_forbidden", "YAML aliases (*) are not accepted.");
    } else if ((isScalar(node) || isCollection(node)) && node.anchor) {
      found = error("anchor_forbidden", "YAML anchors (&) are not accepted.");
    } else if ((isScalar(node) || isCollection(node)) && node.tag) {
      found = error("tag_forbidden", `YAML tag ${node.tag} is not accepted.`);
    }
    return undefined;
  });
  return found;
}

function plainValue(node: BoundaryValue): JsonValue {
  if (node === null || node === undefined) return null;
  if (isScalar(node)) {
    const scalar: { value?: BoundaryValue } = overlapCast(node);
    const value: JsonValue = overlapCast(scalar.value ?? null);
    return value;
  }
  if (isMap(node)) {
    const record: JsonObject = {};
    for (const item of node.items) {
      if (!isScalar(item.key) || !isString(item.key.value)) continue;
      if (DANGEROUS_KEYS.has(item.key.value)) continue;
      record[item.key.value] = plainValue(overlapCast(item.value));
    }
    return record;
  }
  if (isCollection(node)) {
    return node.items.map((item) => plainValue(overlapCast(item)));
  }
  return null;
}

/**
 * Text → plain object, or the first reason it cannot be. Every bound is a
 * refusal, never a truncation: the original bytes stay where they were.
 */
export function parseCapabilityYaml(
  source: string,
): CapabilityDocumentResult<JsonObject> {
  if (source.trim() === "") {
    return fail("empty", "Document is empty; the stored document is kept.");
  }
  if (
    new TextEncoder().encode(source).byteLength > MAX_CAPABILITY_DOCUMENT_BYTES
  ) {
    return fail("too_large", "Document exceeds 64 KiB.");
  }
  const document = parseDocument(source, {
    uniqueKeys: true,
    schema: "core",
    merge: false,
    prettyErrors: false,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) {
    const duplicate = problem.code === "DUPLICATE_KEY";
    return fail(
      duplicate ? "duplicate_key" : "syntax",
      duplicate
        ? "Duplicate mapping key."
        : (problem.message.split("\n")[0] ?? ""),
    );
  }
  const clever = cleverness(document.contents);
  if (clever) return { ok: false, diagnostics: [clever] };
  if (
    depthOf(overlapCast(document.contents), 0) > MAX_CAPABILITY_DOCUMENT_DEPTH
  ) {
    return fail("too_deep", "Document nests deeper than 8 levels.");
  }
  const value = plainValue(overlapCast(document.contents));
  if (!isJsonObject(value)) {
    return fail("not_a_mapping", "Document must be a mapping.");
  }
  return { ok: true, value };
}

function adopt<T>(result: ParseResult<T>): CapabilityDocumentResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  return {
    ok: false,
    diagnostics: result.diagnostics.map((item: Diagnostic) =>
      error(
        item.code,
        item.path ? `${item.path}: ${item.message}` : item.message,
      ),
    ),
  };
}

function through<T>(
  source: string,
  parse: (value: BoundaryValue) => ParseResult<T>,
): CapabilityDocumentResult<T> {
  const yaml = parseCapabilityYaml(source);
  if (!yaml.ok) return yaml;
  return adopt(parse(yaml.value));
}

export function parseInstancePolicySource(
  source: string,
): CapabilityDocumentResult<InstanceCapabilityPolicy> {
  return through(source, parseInstancePolicy);
}

export function parseInstallationSelectionSource(
  source: string,
): CapabilityDocumentResult<InstallationCapabilitySelection> {
  return through(source, parseInstallationSelection);
}

export function parseVaultRestrictionSource(
  source: string,
): CapabilityDocumentResult<VaultCapabilitySelection> {
  return through(source, parseVaultSelection);
}

/** Recursively key-sorted copy, so two equal documents print alike. */
export function sortedDocument(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedDocument);
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) out[key] = sortedDocument(entry);
    }
    return out;
  }
  return value;
}

/** Canonical YAML for one semantic document. Comments never come from here. */
export function documentToYaml(value: BoundaryValue, comment?: string): string {
  const body = stringify(sortedDocument(overlapCast(value)), {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
  return comment ? `${comment.trimEnd()}\n${body}` : body;
}

/** The read-only projection of what the resolver decided. */
export function effectivePlanToYaml(plan: EffectivePlan): string {
  return documentToYaml(
    overlapCast({
      identity: plan.identity,
      provenance: plan.provenance,
      policyValid: plan.policyValid,
      approvedCapabilities: plan.approvedCapabilities,
      approvedModules: plan.approvedModules,
      approvedOperations: plan.approvedOperations,
      requiredWorkerVariant: plan.requiredWorkerVariant,
      conflicts: plan.conflicts,
      consent: plan.consent,
      network: plan.network,
    }),
    "# Read-only. What the resolver decided from the documents beside it.",
  );
}

/** Semantic equality: the same document under two spellings. */
export function documentsEqual(
  left: BoundaryValue,
  right: BoundaryValue,
): boolean {
  return (
    JSON.stringify(sortedDocument(overlapCast(left))) ===
    JSON.stringify(sortedDocument(overlapCast(right)))
  );
}
