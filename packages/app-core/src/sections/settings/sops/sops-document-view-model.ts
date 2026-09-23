/**
 * View-model logic for `SopsDocumentView` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { WorkflowState } from "../../../lib/sops/workflow.js";

/** Untrusted, parse-only facts about a file nobody has opened yet. */
export function inspectionFacts(state: WorkflowState) {
  const inspection = state.inspection;
  if (!inspection) return [{ key: "File", value: state.fileName || "none" }];
  const groups = inspection.keyGroups.length;
  const recipients = inspection.keyGroups.reduce(
    (total, group) => total + group.entries.length,
    0,
  );
  return [
    { key: "Format", value: inspection.format === "json" ? "JSON" : "YAML" },
    { key: "Documents", value: String(inspection.documents) },
    { key: "Key groups", value: groups === 0 ? "none" : String(groups) },
    {
      key: groups > 1 ? "Groups needed" : "Recipients",
      value:
        groups > 1
          ? `${inspection.requiredGroups} of ${groups}`
          : String(recipients),
    },
    {
      key: "Integrity",
      value:
        inspection.integrityMode === "encrypted-values-only"
          ? "Encrypted values only"
          : inspection.integrityMode === "all-supported-values"
            ? "All supported values"
            : "Unknown",
    },
    { key: "Runs in", value: "This browser" },
  ];
}
