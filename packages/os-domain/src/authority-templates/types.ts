/**
 * Audience template vocabulary — types and closed catalogues (ADR 0120).
 */

export const AUDIENCE_TEMPLATE_IDS = [
  "family",
  "contractor",
  "raid",
  "guest",
  "classroom",
  "incident",
  "ci",
  "agent-workcell",
  "research-workshop",
] as const;

export type AudienceTemplateId = (typeof AUDIENCE_TEMPLATE_IDS)[number];

/** Honest statuses only — never enforced / active / protected. */
export const SUPPORT_CLAIM_STATUSES = [
  "unsupported",
  "configuration_required",
  "local_defaults_only",
] as const;

export type SupportClaimStatus = (typeof SUPPORT_CLAIM_STATUSES)[number];

export const USAGE_ACCOUNTING_MODES = [
  "per_device",
  "wall_clock_union",
] as const;

export type UsageAccountingMode = (typeof USAGE_ACCOUNTING_MODES)[number];

export const INHERITANCE_DEFAULTS = ["inherit", "isolated"] as const;
export type InheritanceDefault = (typeof INHERITANCE_DEFAULTS)[number];

export const LIFETIME_KINDS = ["permanent", "temporary"] as const;
export type LifetimeKindDefault = (typeof LIFETIME_KINDS)[number];

/** Surfaces the portal must not advertise as in force without verified wiring. */
export const UNWIRED_PORTAL_SURFACES = [
  "dns.blocky",
  "os.app_blocking",
] as const;

export type UnwiredPortalSurface = (typeof UNWIRED_PORTAL_SURFACES)[number];

/** Keys that would smuggle engine logic into a template document. */
export const FORBIDDEN_TEMPLATE_KEYS = [
  "engineBranch",
  "engine_branch",
  "ifAudience",
  "if_audience",
  "privilegedRole",
  "privileged_role",
  "accessLease",
  "access_lease",
  "evaluate",
  "authorize",
  "bypass",
] as const;

export interface SupportClaim {
  readonly id: string;
  readonly label: string;
  readonly status: SupportClaimStatus;
  readonly note: string;
}

export interface AudienceVocabulary {
  readonly domain: string;
  readonly participant: string;
  readonly supervisor?: string;
}

export interface AudienceDefaults {
  readonly lifetimeKind: LifetimeKindDefault;
  readonly inheritance: InheritanceDefault;
  readonly suggestedVerbs: readonly string[];
  readonly defaultLifetimeMs?: number;
  readonly maxLifetimeMs?: number;
  readonly usageAccounting?: UsageAccountingMode;
}

export interface AudienceLimits {
  readonly maxDelegationDepth?: number;
  readonly requireIndependentApprover?: boolean;
  readonly forbidSecretReadFromSupervision?: boolean;
  readonly endOfEngagementTerminates?: boolean;
  readonly observerOnlyAllowed?: boolean;
}

export type MutableAudienceDefaults = {
  lifetimeKind: LifetimeKindDefault;
  inheritance: InheritanceDefault;
  suggestedVerbs: readonly string[];
  defaultLifetimeMs?: number;
  maxLifetimeMs?: number;
  usageAccounting?: UsageAccountingMode;
};

export type MutableAudienceLimits = {
  maxDelegationDepth?: number;
  requireIndependentApprover?: boolean;
  forbidSecretReadFromSupervision?: boolean;
  endOfEngagementTerminates?: boolean;
  observerOnlyAllowed?: boolean;
};

export interface AudienceTemplate {
  readonly id: AudienceTemplateId;
  readonly version: string;
  readonly label: string;
  readonly summary: string;
  readonly vocabulary: AudienceVocabulary;
  readonly defaults: AudienceDefaults;
  readonly limits: AudienceLimits;
  readonly supportMatrix: readonly SupportClaim[];
  readonly workflowHints: readonly string[];
}

export class AudienceTemplateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AudienceTemplateError";
    this.code = code;
  }
}

export function includesId(ids: readonly string[], value: string): boolean {
  for (const id of ids) {
    if (id === value) return true;
  }
  return false;
}

export function isUnwiredPortalSurface(id: string): boolean {
  return includesId(UNWIRED_PORTAL_SURFACES, id);
}
