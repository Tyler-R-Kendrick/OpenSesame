/**
 * Storage failure / multi-instance / manifest validation helpers (STORE-F).
 */

import {
  type EnrollmentManifest,
  EnrollmentManifestSchema,
  type IncidentRecord,
  IncidentRecordSchema,
} from "@opensesame/contracts/duress";
import { kvDurability } from "../../kv.js";
import type { BoundaryValue } from "../json-boundary.js";

export type StorageReadiness =
  | { ready: true; durability: "persistent" }
  | {
      ready: false;
      code: "undurable_storage" | "unknown_storage";
      durability: ReturnType<typeof kvDurability>;
    };

export function assessDurableStorage(): StorageReadiness {
  const durability = kvDurability();
  if (durability === "persistent") return { ready: true, durability };
  if (durability === "memory") {
    return { ready: false, code: "undurable_storage", durability };
  }
  return { ready: false, code: "unknown_storage", durability };
}

export function parseEnrollmentManifest(
  raw: BoundaryValue,
):
  | { ok: true; manifest: EnrollmentManifest }
  | { ok: false; code: "invalid_manifest"; issues: string[] } {
  const parsed = EnrollmentManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_manifest",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  }
  return { ok: true, manifest: parsed.data };
}

export function parseIncidentRecord(
  raw: BoundaryValue,
):
  | { ok: true; record: IncidentRecord }
  | { ok: false; code: "invalid_manifest"; issues: string[] } {
  const parsed = IncidentRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_manifest",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  }
  return { ok: true, record: parsed.data };
}

/** Detect sibling-root carry attempts from wrap-equality alone. */
export function isSiblingRootCarryAttempt(input: {
  sourceIndependent: boolean;
  targetIndependent: boolean;
  sharesWrapPrediction: boolean;
}): boolean {
  if (
    !input.sourceIndependent &&
    input.targetIndependent &&
    input.sharesWrapPrediction
  ) {
    return true;
  }
  if (
    input.sourceIndependent &&
    input.targetIndependent &&
    input.sharesWrapPrediction
  ) {
    return true;
  }
  return false;
}
