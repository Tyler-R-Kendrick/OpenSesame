/**
 * Bounded automatic-acquisition controller. One attempt per eligible
 * activation for one selected provider. Default personal mode does no I/O.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { page } from "../../ports.js";
import type { OperatorIdp } from "../settings.js";
import { runSilentIframeAttempt } from "./controller-silent.js";
import {
  attemptOnCooldown,
  currentAuthGeneration,
  isAutoAuthSuppressed,
  writeAttemptRecord,
} from "./generation.js";
import { beginAmbientOidc } from "./oidc.js";
import {
  type AmbientAuthPolicy,
  type AmbientPolicyDecision,
  resolveAmbientAuthPolicy,
} from "./policy.js";
import type { ProviderConnection } from "./provider.js";
import type { AmbientReasonCode, PassiveOutcome } from "./types.js";

export type ControllerState =
  | "ineligible"
  | "restoring"
  | "eligible"
  | "attempting"
  | "authenticated"
  | "needs-interaction"
  | "unavailable"
  | "cancelled";

export type EligibilityInput = {
  hasAuthCallback: boolean;
  pathname: string;
  vaultStatus: "empty" | "locked" | "unlocked";
  guestOpen: boolean;
  privilegedOperation: boolean;
  unsavedWork: boolean;
  localConsentRoute: boolean;
  existingVerifiedSession: boolean;
  operatorProviders: readonly OperatorIdp[];
  runtimePolicy?: BoundaryValue;
  userPreference?: BoundaryValue;
  lastSignInMethod?: string | null;
  openPairwiseSub?: string;
  now?: number;
};

export type Eligibility = {
  state: ControllerState;
  decision: AmbientPolicyDecision;
  reason: AmbientReasonCode;
  connection: ProviderConnection | null;
  policy: AmbientAuthPolicy;
  vaultStatus: EligibilityInput["vaultStatus"];
  guestOpen: boolean;
  openPairwiseSub?: string;
};

const LOCAL_ROUTES = [
  "/identity/authorize",
  "/identity/siop",
  "/broker/authorize",
];

function isLocalRoute(input: EligibilityInput): boolean {
  if (input.localConsentRoute) return true;
  return LOCAL_ROUTES.some((path) => input.pathname.startsWith(path));
}

function isBusyWorkspace(input: EligibilityInput): boolean {
  return input.guestOpen || input.privilegedOperation || input.unsavedWork;
}

function policyIneligibleReason(
  reason: AmbientPolicyDecision["reason"],
): AmbientReasonCode {
  if (reason === "unsupported") return "unsupported";
  if (reason === "provider-removed") return "rejected";
  return "disabled";
}

function eligibilityBase(
  input: EligibilityInput,
  decision: AmbientPolicyDecision,
): Omit<Eligibility, "state" | "reason"> {
  const base: Omit<Eligibility, "state" | "reason"> = {
    decision,
    connection: decision.connection,
    policy: decision.policy,
    vaultStatus: input.vaultStatus,
    guestOpen: input.guestOpen,
  };
  if (input.openPairwiseSub) {
    base.openPairwiseSub = input.openPairwiseSub;
  }
  return base;
}

export function evaluateEligibility(input: EligibilityInput): Eligibility {
  const decision = resolveAmbientAuthPolicy({
    runtime: input.runtimePolicy,
    userPreference: input.userPreference,
    lastSignInMethod: input.lastSignInMethod,
    operatorProviders: input.operatorProviders,
  });
  const base = eligibilityBase(input, decision);
  if (input.hasAuthCallback) {
    return { ...base, state: "ineligible", reason: "ineligible" };
  }
  if (isLocalRoute(input)) {
    return { ...base, state: "ineligible", reason: "local_flow" };
  }
  if (isBusyWorkspace(input)) {
    return { ...base, state: "ineligible", reason: "guest_open" };
  }
  if (isAutoAuthSuppressed()) {
    return { ...base, state: "ineligible", reason: "suppressed" };
  }
  if (input.existingVerifiedSession) {
    return { ...base, state: "restoring", reason: "ineligible" };
  }
  if (!decision.eligible || !decision.connection) {
    return {
      ...base,
      state: "ineligible",
      reason: policyIneligibleReason(decision.reason),
    };
  }
  const now = input.now ?? Date.now();
  if (
    attemptOnCooldown(
      now,
      decision.policy.cooldownMs,
      decision.connection.key,
      decision.policy.policyRevision,
    )
  ) {
    return { ...base, state: "ineligible", reason: "attempt_budget" };
  }
  return { ...base, state: "eligible", reason: "ineligible" };
}

export type ControllerClock = { now(): number };
export type ControllerNavigate = (url: string) => void;
export type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type AmbientControllerSeams = {
  discover: (issuer: string) => Promise<Discovery>;
  navigate: ControllerNavigate;
  clock: ControllerClock;
};

export const ambientControllerSeams: AmbientControllerSeams = {
  discover: async () => {
    throw new Error("discovery not wired");
  },
  navigate: (url) => {
    page().location.assign(url);
  },
  clock: { now: () => Date.now() },
};

function claimAttempt(eligibility: Eligibility): boolean {
  if (!eligibility.connection) return false;
  const now = ambientControllerSeams.clock.now();
  if (
    attemptOnCooldown(
      now,
      eligibility.policy.cooldownMs,
      eligibility.connection.key,
      eligibility.policy.policyRevision,
    )
  ) {
    return false;
  }
  writeAttemptRecord({
    providerKey: eligibility.connection.key,
    policyRevision: eligibility.policy.policyRevision,
    at: now,
  });
  return true;
}

export async function runAutomaticAttempt(
  eligibility: Eligibility,
  redirectUri: string,
): Promise<PassiveOutcome> {
  if (eligibility.state !== "eligible" || !eligibility.connection) {
    return { kind: "cancelled" };
  }
  if (eligibility.connection.protocol === "shoo") {
    return { kind: "unsupported", reason: "unsupported" };
  }
  if (!claimAttempt(eligibility)) {
    return { kind: "rejected", reason: "attempt_budget" };
  }
  const generation = currentAuthGeneration();
  if (eligibility.policy.allowedTransport === "interactive-continue") {
    return { kind: "interaction-required", reason: "interaction_required" };
  }
  if (eligibility.policy.allowedTransport === "silent-iframe") {
    return runSilentIframeAttempt(eligibility, redirectUri, generation);
  }
  const discovery = await ambientControllerSeams.discover(
    eligibility.connection.issuer,
  );
  const { url } = await beginAmbientOidc({
    connection: eligibility.connection,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
    jwksUri: discovery.jwks_uri,
    redirectUri,
    intent: {
      kind: "ambient",
      policyRevision: eligibility.policy.policyRevision,
      selectedProviderKey: eligibility.connection.key,
    },
    transport: eligibility.policy.allowedTransport,
    policyRevision: eligibility.policy.policyRevision,
    now: ambientControllerSeams.clock.now(),
  });
  if (generation !== currentAuthGeneration()) {
    return { kind: "rejected", reason: "stale_generation" };
  }
  ambientControllerSeams.navigate(url);
  return { kind: "interaction-required", reason: "login_required" };
}

let inFlight: Promise<PassiveOutcome> | null = null;

export function resetAmbientController(): void {
  inFlight = null;
}

export async function startAutomaticAttempt(
  eligibility: Eligibility,
  redirectUri: string,
): Promise<PassiveOutcome> {
  if (inFlight) return inFlight;
  inFlight = runAutomaticAttempt(eligibility, redirectUri).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
