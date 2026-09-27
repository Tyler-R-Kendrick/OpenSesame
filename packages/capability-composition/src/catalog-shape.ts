/**
 * A descriptor's shape: every field it carries is one the contract knows,
 * and every list is bounded (carried from #470's descriptor parser, which
 * refused an unknown field and a list past its bound). A catalog is authored
 * in code, but a misspelt field there — `requiresDocumentReloud: true` —
 * would otherwise be dropped without a word and the capability would ship
 * without the constraint its author meant it to have.
 */
import { type Diagnostic, diagnostic, pushDiagnostic } from "./diagnostics.js";
import type { CapabilityDescriptor } from "./types.js";

/** Longest list a descriptor may declare in any one field. */
export const MAX_DESCRIPTOR_LIST = 64;

const DESCRIPTOR_FIELDS = new Set(
  Object.keys({
    id: true,
    descriptorVersion: true,
    tier: true,
    title: true,
    summary: true,
    dependencies: true,
    alternatives: true,
    operationIds: true,
    moduleIds: true,
    environments: true,
    egress: true,
    browserPermissions: true,
    keyAccess: true,
    requiresService: true,
    offlineLimits: true,
    workerGraphConstraint: true,
    requiresDocumentReload: true,
    itemKinds: true,
    exposureDigest: true,
  } satisfies { [K in keyof CapabilityDescriptor]-?: true }),
);

function listsOf(
  d: CapabilityDescriptor,
): ReadonlyArray<readonly [string, readonly unknown[]]> {
  return [
    ["dependencies", d.dependencies],
    ["alternatives", d.alternatives],
    ["operationIds", d.operationIds],
    ["moduleIds", d.moduleIds],
    ["environments", d.environments],
    ["egress", d.egress],
    ["browserPermissions", d.browserPermissions],
    ["itemKinds", d.itemKinds],
    ["keyAccess", typeof d.keyAccess === "string" ? [] : d.keyAccess],
    ...d.alternatives.map(
      (a, i) => [`alternatives[${i}].oneOf`, a.oneOf] as const,
    ),
  ];
}

export function checkShape(
  d: CapabilityDescriptor,
  path: string,
  diags: Diagnostic[],
): void {
  for (const key of Object.keys(d)) {
    if (DESCRIPTOR_FIELDS.has(key)) continue;
    pushDiagnostic(
      diags,
      diagnostic(
        "UNKNOWN_FIELD",
        `${path}.${key}`,
        `\`${key}\` is not a descriptor field`,
      ),
    );
  }
  for (const [field, list] of listsOf(d)) {
    if (list.length <= MAX_DESCRIPTOR_LIST) continue;
    pushDiagnostic(
      diags,
      diagnostic(
        "TOO_MANY_ITEMS",
        `${path}.${field}`,
        `\`${field}\` exceeds ${MAX_DESCRIPTOR_LIST} entries`,
      ),
    );
  }
}
