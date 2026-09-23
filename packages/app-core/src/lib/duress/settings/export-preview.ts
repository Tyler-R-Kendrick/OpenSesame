/**
 * Safe export/import preview — never surfaces enrolled codes or PRF material.
 */

import {
  type CompilerCatalog,
  compileDuressPolicy,
} from "@opensesame/contracts";
import type { PolicyDocument } from "@opensesame/contracts";
import { PolicyDocumentSchema } from "@opensesame/contracts";
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "../json-boundary.js";
import { redactSecrets } from "./arming.js";
import { formatExposureLines } from "./exposure.js";

const SECRET_KEY = /code|pin|prf|share|secret|password|keyMaterial|slotCipher/i;

export type ImportPreview = Readonly<{
  ok: boolean;
  wouldArm: false;
  policyId: string | null;
  revision: number | null;
  enabledFlag: boolean;
  profileLabels: readonly string[];
  exposureLines: readonly string[];
  diagnostics: readonly string[];
  redactedDocument: JsonValue;
}>;

function boundaryLeafToJson(value: BoundaryValue): JsonValue {
  if (
    value === null ||
    isString(value) ||
    isNumber(value) ||
    isBoolean(value)
  ) {
    return value;
  }
  return null;
}

function stripSecretsDeep(value: BoundaryValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripSecretsDeep);
  if (!isJsonObject(value)) {
    return value === undefined ? null : boundaryLeafToJson(value);
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = stripSecretsDeep(v);
    }
  }
  return out;
}

function policyWireCopy(document: PolicyDocument): BoundaryValue {
  const wire = JSON.parse(JSON.stringify(document));
  const parsed = PolicyDocumentSchema.safeParse(wire);
  if (!parsed.success) {
    return {};
  }
  return overlapCast<PolicyDocument, BoundaryValue>(parsed.data);
}

export function previewImportDocument(
  document: PolicyDocument,
  catalog: CompilerCatalog,
): ImportPreview {
  const redactedDocument = stripSecretsDeep(policyWireCopy(document));
  const compiled = compileDuressPolicy(document, catalog);
  if (!compiled.ok) {
    return {
      ok: false,
      wouldArm: false,
      policyId: null,
      revision: null,
      enabledFlag: false,
      profileLabels: [],
      exposureLines: [],
      diagnostics: compiled.diagnostics.map(
        (d) => `${d.code}@${d.path}: ${d.message}`,
      ),
      redactedDocument,
    };
  }
  return {
    ok: true,
    wouldArm: false,
    policyId: compiled.policy.policyId,
    revision: compiled.policy.revision,
    enabledFlag: compiled.policy.enabled,
    profileLabels: compiled.policy.profiles.map((p) => p.label),
    exposureLines: formatExposureLines(compiled.exposures),
    diagnostics: [],
    redactedDocument,
  };
}

export type DisarmStatusPreview = Readonly<{
  armed: boolean;
  codesVisible: false;
  message: string;
}>;

export function previewDisarmStatus(armed: boolean): DisarmStatusPreview {
  return {
    armed,
    codesVisible: false,
    message: armed
      ? "Disarm retires enrolled triggers without displaying stored codes."
      : "No armed duress profile on this device.",
  };
}

export function safeStatusPayload(payload: JsonObject): JsonObject {
  return redactSecrets(payload);
}
