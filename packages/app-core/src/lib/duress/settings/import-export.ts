/**
 * Export / import preview — enabled:true never arms.
 */

import type {
  CompilerCatalog,
  PolicyDocument,
} from "@opensesame/contracts/duress";
import { PolicyDocumentSchema } from "@opensesame/contracts/duress";
import { parse as parseYaml } from "yaml";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "../json-boundary.js";
import { redactSecrets } from "./arming.js";
import {
  type CompiledPolicyPreview,
  previewCompiledPolicy,
} from "./exposure.js";

export type PolicyImportPreview = Readonly<{
  parseOk: boolean;
  document: PolicyDocument | null;
  preview: CompiledPolicyPreview | null;
  /** Always false — import cannot arm. */
  armed: false;
  warnings: readonly string[];
}>;

export function parsePolicyDocument(
  raw: string,
  format: "json" | "yaml" = "json",
): { ok: true; document: PolicyDocument } | { ok: false; message: string } {
  let value: BoundaryValue;
  try {
    value = format === "yaml" ? parseYaml(raw) : JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "parse_failed",
    };
  }
  const parsed = PolicyDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "schema_failed",
    };
  }
  return { ok: true, document: parsed.data };
}

export function previewImport(
  raw: string,
  catalog: CompilerCatalog,
  format: "json" | "yaml" = "json",
): PolicyImportPreview {
  const parsed = parsePolicyDocument(raw, format);
  if (!parsed.ok) {
    return {
      parseOk: false,
      document: null,
      preview: null,
      armed: false,
      warnings: [parsed.message],
    };
  }

  const warnings: string[] = [];
  if (parsed.document.enabled) {
    warnings.push(
      "Document has enabled:true — import is preview only and does not arm.",
    );
  }

  const preview = previewCompiledPolicy(parsed.document, catalog, {
    ownerConsent: false,
    rehearsalPassed: false,
    durableStorage: catalog.durableStorage,
    enrolledTriggers: false,
  });

  return {
    parseOk: true,
    document: parsed.document,
    preview,
    armed: false,
    warnings,
  };
}

export type ExportPolicyPreview = Readonly<{
  json: string;
  containsSecrets: false;
}>;

export function exportPolicyPreview(
  document: PolicyDocument,
): ExportPolicyPreview {
  // SAFETY: JSON.stringify of PolicyDocument yields JSON; parse returns BoundaryValue-shaped tree.
  const wire = JSON.parse(JSON.stringify(document)) as BoundaryValue;
  if (!isJsonObject(wire)) {
    return { json: "{}", containsSecrets: false };
  }
  const redacted: JsonObject = redactSecrets(wire);
  return {
    json: JSON.stringify(redacted, null, 2),
    containsSecrets: false,
  } satisfies ExportPolicyPreview;
}
