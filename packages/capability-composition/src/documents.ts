/**
 * Operator policy documents: instance policy, vault restriction,
 * installation selection. YAML-shaped data with strict validators.
 *
 * The allow-set is a discriminated field so it is never ambiguous:
 * `allow: "inherit"` defers to the parent scope; `allow: { ids: [...] }`
 * is an explicit set where an empty array means allow none. A document
 * without the field is never mistaken for "inherit everything".
 */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type Fail,
  idArray,
  plainId,
  readAllowSet,
  readRevision,
  rejectUnknown,
  validateBase,
  validateNetwork,
  validateUpdates,
} from "./documents-helpers.js";
import type { DocumentKind } from "./ids.js";

/** Upper bounds that keep a hostile document from stalling resolution. */
export const DOCUMENT_LIMITS = {
  maxCapabilities: 256,
  maxOrigins: 64,
  maxIdLength: 200,
} as const;

/** An explicit capability allow set, never a wildcard. */
export type ExplicitAllowSet = { readonly ids: readonly string[] };

/** Scope inheritance marker: absent allow set ≡ defer to parent scope. */
export type AllowSet = "inherit" | ExplicitAllowSet;

export type NetworkPolicy = {
  readonly externalServices: "allow" | "deny";
  readonly allowedServiceOrigins: readonly string[];
};

export type UpdatesPolicy = {
  readonly unknownCapabilities: "deny" | "review";
  readonly expandedExposure: "require-approval" | "allow";
};

export type PolicyDocumentBase = {
  readonly schemaVersion: 1;
  readonly kind: DocumentKind;
  readonly revision: number;
};

export type InstancePolicyDocument = PolicyDocumentBase & {
  readonly kind: "instance-policy";
  readonly instanceId: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly prohibited: readonly string[];
  readonly network: NetworkPolicy;
  readonly updates: UpdatesPolicy;
};

export type VaultRestrictionDocument = PolicyDocumentBase & {
  readonly kind: "vault-restriction";
  readonly instanceId: string;
  readonly vaultId: string;
  readonly basePolicyRevision: number;
  readonly allow: AllowSet;
  readonly optional: readonly string[];
  readonly prohibited: readonly string[];
};

export type InstallationSelectionDocument = PolicyDocumentBase & {
  readonly kind: "installation-selection";
  readonly instanceId: string;
  readonly vaultId: string | null;
  readonly installationId: string;
  readonly vaultIdSource: "derived" | "explicit";
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly prohibited: readonly string[];
  readonly allow: AllowSet;
};

export type DocumentValidationFailure = {
  readonly field: string;
  readonly problem: string;
};

export type DocumentValidation<T> =
  | { readonly ok: true; readonly document: T }
  | {
      readonly ok: false;
      readonly failures: readonly DocumentValidationFailure[];
    };

/** Validate an instance policy document. */
export function validateInstancePolicy(
  value: BoundaryValue,
): DocumentValidation<InstancePolicyDocument> {
  const failures: DocumentValidationFailure[] = [];
  const push: Fail = (field, problem) => {
    failures.push({ field, problem });
  };
  if (!validateBase(value, "instance-policy", push)) {
    return { ok: false, failures };
  }
  rejectUnknown(
    value,
    [
      "schemaVersion",
      "kind",
      "instanceId",
      "revision",
      "required",
      "optional",
      "prohibited",
      "network",
      "updates",
    ],
    push,
  );
  const instanceId = plainId(value.instanceId, "instanceId", push);
  const required = idArray(value.required, "required", push);
  const optional = idArray(value.optional, "optional", push);
  const prohibited = idArray(value.prohibited, "prohibited", push);
  const network = validateNetwork(value.network, push);
  const updates = validateUpdates(value.updates, push);
  const revision = readRevision(value.revision, push);
  if (
    failures.length > 0 ||
    instanceId === undefined ||
    network === undefined ||
    updates === undefined ||
    revision === undefined
  ) {
    return { ok: false, failures };
  }
  return {
    ok: true,
    document: {
      schemaVersion: 1,
      kind: "instance-policy",
      instanceId,
      required,
      optional,
      prohibited,
      network,
      updates,
      revision,
    },
  };
}

/** Validate a vault restriction document. */
export function validateVaultRestriction(
  value: BoundaryValue,
): DocumentValidation<VaultRestrictionDocument> {
  const failures: DocumentValidationFailure[] = [];
  const push: Fail = (field, problem) => {
    failures.push({ field, problem });
  };
  if (!validateBase(value, "vault-restriction", push)) {
    return { ok: false, failures };
  }
  rejectUnknown(
    value,
    [
      "schemaVersion",
      "kind",
      "instanceId",
      "vaultId",
      "basePolicyRevision",
      "revision",
      "allow",
      "optional",
      "prohibited",
    ],
    push,
  );
  const instanceId = plainId(value.instanceId, "instanceId", push);
  const vaultId = plainId(value.vaultId, "vaultId", push);
  const basePolicyRevision = readRevision(value.basePolicyRevision, push);
  const revision = readRevision(value.revision, push);
  const allow = readAllowSet(value.allow, push);
  const optional = idArray(value.optional, "optional", push);
  const prohibited = idArray(value.prohibited, "prohibited", push);
  if (
    failures.length > 0 ||
    instanceId === undefined ||
    vaultId === undefined ||
    basePolicyRevision === undefined ||
    revision === undefined
  ) {
    return { ok: false, failures };
  }
  return {
    ok: true,
    document: {
      schemaVersion: 1,
      kind: "vault-restriction",
      instanceId,
      vaultId,
      basePolicyRevision,
      revision,
      allow: allow ?? "inherit",
      optional,
      prohibited,
    },
  };
}

/** Validate an installation selection document. */
export function validateInstallationSelection(
  value: BoundaryValue,
): DocumentValidation<InstallationSelectionDocument> {
  const failures: DocumentValidationFailure[] = [];
  const push: Fail = (field, problem) => {
    failures.push({ field, problem });
  };
  if (!validateBase(value, "installation-selection", push)) {
    return { ok: false, failures };
  }
  rejectUnknown(
    value,
    [
      "schemaVersion",
      "kind",
      "instanceId",
      "vaultId",
      "vaultIdSource",
      "installationId",
      "revision",
      "required",
      "optional",
      "prohibited",
      "allow",
    ],
    push,
  );
  const instanceId = plainId(value.instanceId, "instanceId", push);
  const installationId = plainId(value.installationId, "installationId", push);
  const vaultId =
    value.vaultId === undefined || value.vaultId === null
      ? null
      : plainId(value.vaultId, "vaultId", push);
  let vaultIdSource: "derived" | "explicit" | undefined;
  if (
    isString(value.vaultIdSource) &&
    (value.vaultIdSource === "derived" || value.vaultIdSource === "explicit")
  ) {
    vaultIdSource = value.vaultIdSource;
  } else {
    push("vaultIdSource", `"derived" | "explicit"`);
  }
  const revision = readRevision(value.revision, push);
  const required = idArray(value.required, "required", push);
  const optional = idArray(value.optional, "optional", push);
  const prohibited = idArray(value.prohibited, "prohibited", push);
  const allow = readAllowSet(value.allow, push);
  if (
    failures.length > 0 ||
    instanceId === undefined ||
    installationId === undefined ||
    vaultId === undefined ||
    vaultIdSource === undefined ||
    revision === undefined
  ) {
    return { ok: false, failures };
  }
  return {
    ok: true,
    document: {
      schemaVersion: 1,
      kind: "installation-selection",
      instanceId,
      vaultId,
      vaultIdSource,
      installationId,
      revision,
      required,
      optional,
      prohibited,
      allow: allow ?? "inherit",
    },
  };
}
