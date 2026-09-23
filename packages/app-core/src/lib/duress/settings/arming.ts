/**
 * Settings helpers — compiler-driven exposure; never echo enrolled codes.
 */

import {
  type CompilerCatalog,
  compileDuressPolicy,
  dryRunDuressPolicy,
} from "@opensesame/contracts";
import type { PolicyDocument } from "@opensesame/contracts";
import {
  type BoundaryValue,
  type JsonObject,
  type MutableJsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { CodeSlotStatus } from "./codes.js";

export type ArmingChecklist = Readonly<{
  ownerConsent: boolean;
  destructiveAck: boolean;
  rehearsalPassed: boolean;
  durableStorage: boolean;
  enrolledTriggers: boolean;
  exposureReviewed: boolean;
}>;

export function emptyArmingChecklist(
  overrides: Partial<ArmingChecklist> = {},
): ArmingChecklist {
  return {
    ownerConsent: false,
    destructiveAck: false,
    rehearsalPassed: false,
    durableStorage: false,
    enrolledTriggers: false,
    exposureReviewed: false,
    ...overrides,
  };
}

export function canArmProfile(checklist: ArmingChecklist): boolean {
  return (
    checklist.ownerConsent &&
    checklist.destructiveAck &&
    checklist.rehearsalPassed &&
    checklist.durableStorage &&
    checklist.enrolledTriggers &&
    checklist.exposureReviewed
  );
}

/**
 * Accidental-activation guard: missing any gate keeps arm disabled.
 * Import `enabled: true` alone never satisfies this checklist.
 */
export function explainArmBlockers(checklist: ArmingChecklist): string[] {
  const blockers: string[] = [];
  if (!checklist.ownerConsent) blockers.push("owner_consent");
  if (!checklist.destructiveAck) blockers.push("destructive_ack");
  if (!checklist.rehearsalPassed) blockers.push("isolated_rehearsal");
  if (!checklist.durableStorage) blockers.push("durable_storage");
  if (!checklist.enrolledTriggers) blockers.push("enrolled_triggers");
  if (!checklist.exposureReviewed) blockers.push("exposure_reviewed");
  return blockers;
}

export type PolicyPreview = Readonly<{
  compiled: ReturnType<typeof compileDuressPolicy>;
  dry: ReturnType<typeof dryRunDuressPolicy>;
  wouldArm: false;
}>;

export function previewPolicy(
  document: PolicyDocument,
  catalog: CompilerCatalog,
  checklist: ArmingChecklist,
): PolicyPreview {
  const compiled = compileDuressPolicy(document, catalog);
  const dry = dryRunDuressPolicy(document, catalog, checklist);
  return { compiled, dry, wouldArm: false };
}

const SECRET_KEY = /^(.*)?(code|pin|prf|share|secret|password)(.*)?$/i;

/** Codes and secrets are never returned to UI/logs. */
export function redactSecrets(value: JsonObject): JsonObject {
  const clone: MutableJsonObject = { ...value };
  for (const key of Object.keys(clone)) {
    if (SECRET_KEY.test(key)) {
      clone[key] = "[redacted]";
    } else {
      const nested = clone[key];
      if (isJsonObject(nested)) {
        clone[key] = redactSecrets(nested);
      }
    }
  }
  return clone;
}

export type CodeLeakScan = { ok: true } | { ok: false; leakedKeys: string[] };

/** Detect whether a view-model accidentally retained enrolled cleartext. */
export function assertNoEnrolledCodeDisplay(
  viewModel: JsonObject | CodeSlotStatus,
): CodeLeakScan {
  const leaked: string[] = [];
  const walk = (obj: JsonObject, path: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const here = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && isString(v) && v !== "[redacted]") {
        if (k === "materialDigest" || k.endsWith("Digest")) continue;
        if (v.length >= 4) leaked.push(here);
      }
      if (isJsonObject(v)) {
        walk(v, here);
      }
    }
  };
  walk(viewModel, "");
  return leaked.length === 0 ? { ok: true } : { ok: false, leakedKeys: leaked };
}
