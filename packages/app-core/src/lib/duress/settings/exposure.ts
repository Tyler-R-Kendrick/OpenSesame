import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Compiler-driven exposure presentation for settings.
 * Never invent security claims; only format CONTRACT ExposureSummary.
 */

import type {
  CompilerCatalog,
  EffectAssurance,
  ExposureSummary,
  PolicyDocument,
} from "@opensesame/contracts";
import { compileDuressPolicy, dryRunDuressPolicy } from "@opensesame/contracts";
import type { ArmingChecklist } from "./arming.js";

export type ExposureLine = Readonly<{
  kind: "admit" | "deny" | "path" | "warning" | "disclosure" | "assurance";
  text: string;
}>;

/** Human-readable lines from a compiler ExposureSummary (no secrets). */
export function formatExposureSummary(
  exposure: ExposureSummary,
): ExposureLine[] {
  const lines: ExposureLine[] = [];
  for (const ref of exposure.admittedCompartmentRefs) {
    lines.push({ kind: "admit", text: `Admitted compartment: ${ref}` });
  }
  for (const ref of exposure.deniedCompartmentRefs) {
    lines.push({ kind: "deny", text: `Denied compartment: ${ref}` });
  }
  for (const label of exposure.unlockPathLabels) {
    lines.push({ kind: "path", text: `Unlock path label: ${label}` });
  }
  for (const warning of exposure.alternateWrapperWarnings) {
    lines.push({
      kind: "warning",
      text: `Alternate wrapper warning: ${warning}`,
    });
  }
  if (exposure.historicalCopyDisclosure) {
    lines.push({
      kind: "disclosure",
      text: "Historical offline copies with prior keys remain a disclosed residual risk.",
    });
  }
  return lines;
}

export function formatAssurances(
  assurances: readonly EffectAssurance[],
): ExposureLine[] {
  return assurances.map((a) => ({
    kind: "assurance" as const,
    text: `${a.effect}: ${a.level}${a.detail ? ` — ${a.detail}` : ""}`,
  }));
}

export type CompiledPolicyPreview = Readonly<{
  ok: boolean;
  wouldArm: false;
  lines: ExposureLine[];
  diagnostics: readonly { code: string; path: string; message: string }[];
  missingReadiness: readonly string[];
  profileIds: readonly string[];
}>;

/** Compile + dry-run; import/enabled never arms. */
export function previewCompiledPolicy(
  document: PolicyDocument,
  catalog: CompilerCatalog,
  checklist: Pick<
    ArmingChecklist,
    "ownerConsent" | "rehearsalPassed" | "durableStorage" | "enrolledTriggers"
  >,
): CompiledPolicyPreview {
  const compiled = compileDuressPolicy(document, catalog);
  const dry = dryRunDuressPolicy(document, catalog, checklist);

  if (!compiled.ok) {
    return {
      ok: false,
      wouldArm: false,
      lines: [],
      diagnostics: compiled.diagnostics,
      missingReadiness: dry.missingReadiness,
      profileIds: [],
    };
  }

  const lines: ExposureLine[] = [];
  for (const exposure of compiled.exposures) {
    lines.push(...formatExposureSummary(exposure));
  }
  lines.push(...formatAssurances(compiled.assurances));

  return {
    ok: true,
    wouldArm: false,
    lines,
    diagnostics: [],
    missingReadiness: dry.missingReadiness,
    profileIds: dry.profileIds,
  };
}

/** Plain strings for list UIs that already expect string[]. */
export function exposureLinesAsText(lines: readonly ExposureLine[]): string[] {
  return lines.map((l) => l.text);
}

/** Format compiler exposures for settings lists (no duplicated security logic). */
export function formatExposureLines(
  exposures: readonly ExposureSummary[],
): string[] {
  const lines: string[] = [];
  for (const exposure of exposures) {
    lines.push(...exposureLinesAsText(formatExposureSummary(exposure)));
  }
  return lines;
}
