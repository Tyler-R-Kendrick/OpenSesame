/**
 * Ambient SSO contracts (ADR 0125).
 *
 * Intent is saved before leaving the app and recovered by transaction
 * correlation — never inferred from the callback URL or the active principal.
 */

export const AUTHENTICATION_INTENT_KINDS = [
  "ambient",
  "sign-in",
  "switch-account",
  "reauthenticate",
  "attach-account",
  "join-organization",
] as const;

export type AuthenticationIntentKind =
  (typeof AUTHENTICATION_INTENT_KINDS)[number];

export type AuthenticationIntent =
  | {
      kind: "ambient";
      policyRevision: string;
      selectedProviderKey: string;
    }
  | { kind: "sign-in"; requestedProviderKey: string }
  | { kind: "switch-account"; previousAccountKey?: string }
  | { kind: "reauthenticate"; expectedAccountKey: string; reason: string }
  | {
      kind: "attach-account";
      targetPrincipalId: string;
      interactionRef: string;
    }
  | {
      kind: "join-organization";
      organizationId: string;
      interactionRef: string;
    };

export const PASSIVE_OUTCOME_KINDS = [
  "authenticated",
  "interaction-required",
  "account-mismatch",
  "unsupported",
  "unavailable",
  "cancelled",
  "rejected",
] as const;

export type PassiveOutcomeKind = (typeof PASSIVE_OUTCOME_KINDS)[number];

export const AMBIENT_REASON_CODES = [
  "disabled",
  "ineligible",
  "unsupported",
  "unavailable",
  "interaction_required",
  "login_required",
  "consent_required",
  "account_mismatch",
  "stale_policy",
  "stale_generation",
  "cancelled",
  "rejected",
  "timeout",
  "uncorrelated",
  "duplicate_params",
  "mixup",
  "expired",
  "locked_vault",
  "guest_open",
  "local_flow",
  "legacy_pending",
  "suppressed",
  "attempt_budget",
] as const;

export type AmbientReasonCode = (typeof AMBIENT_REASON_CODES)[number];

export type PassiveOutcome =
  | {
      kind: "authenticated";
      verifiedIdentityRef: string;
      transactionId: string;
    }
  | { kind: "interaction-required"; reason: AmbientReasonCode }
  | { kind: "account-mismatch" }
  | { kind: "unsupported"; reason: AmbientReasonCode }
  | { kind: "unavailable"; reason: AmbientReasonCode }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: AmbientReasonCode };

export type AmbientTransport =
  | "silent-redirect"
  | "silent-iframe"
  | "interactive-continue";

export type AmbientAuthMode =
  | "disabled"
  | "returning-opt-in"
  | "deployment-selected";

export type AmbientPolicyProvenance =
  | "default"
  | "user-opt-in"
  | "deployment-runtime"
  | "invalid";

export const PROVIDER_CAPABILITIES = [
  "interactive-oidc",
  "silent-redirect",
  "silent-iframe",
  "account-selection",
  "reauthentication",
  "fedcm-auto",
  "local-logout",
  "upstream-logout",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export type ProviderProtocol = "oidc" | "entra" | "shoo" | "fedcm";

export type ProviderConnectionKey = string & {
  readonly __providerConnectionKey: unique symbol;
};

export function isAmbientIntent(
  intent: AuthenticationIntent | undefined,
): intent is Extract<AuthenticationIntent, { kind: "ambient" }> {
  return intent?.kind === "ambient";
}

export function isAmbientReasonCode(value: string): value is AmbientReasonCode {
  // SAFETY: test/fixture or boundary-checked value matches readonly string[]).includes(value).
  return (AMBIENT_REASON_CODES as readonly string[]).includes(value);
}
