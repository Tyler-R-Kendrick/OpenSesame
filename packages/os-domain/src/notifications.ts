/**
 * Where a person is interrupted, and what it takes to say yes (ADR 0081).
 *
 * Two questions look like one and are not:
 *
 *   *Where do I hear about this?*  — the person's preference.
 *   *What does it take to allow it?* — the operator's policy.
 *
 * Conflating them is the whole failure mode. If choosing Slack for
 * convenience also chose Slack as the authority that may approve production
 * root access, then a preference toggle would be a privilege escalation, and
 * a stolen chat session would be worth as much as a hardware authenticator.
 * So the vocabulary here keeps them apart and makes the composition
 * one-directional: a preference may only ever *narrow* the set of
 * destinations policy already allows, and a channel may only ever *report*
 * assurance facts its adapter can actually produce.
 *
 * Everything in this module is pure: no HTTP, no persistence, no provider
 * SDKs. The composition with the assurance evaluator lives in
 * `@opensesame/trust-broker`, so there stays exactly one evaluator.
 */

import type { JsonObject } from "./json.js";
import type {
  AssuranceRequirement,
  AuthenticationFacts,
  DeviceBinding,
  KeyProtection,
  UserVerification,
} from "./trust.js";
import type { PrincipalId } from "./types.js";

/**
 * A delivery mechanism. Not an authenticator — the distinction is the point.
 *
 * `in_app` is the durable OpenSesame inbox and is not really a "channel" at
 * all: it is the canonical surface the others merely point at. It appears
 * here so routing can name it, and it can never be turned off.
 */
export type NotificationChannelKind =
  | "in_app"
  | "native_push"
  | "slack"
  | "teams"
  | "telegram"
  | "wechat"
  | "sms"
  | "webhook";

export const NOTIFICATION_CHANNEL_KINDS: readonly NotificationChannelKind[] = [
  "in_app",
  "native_push",
  "slack",
  "teams",
  "telegram",
  "wechat",
  "sms",
  "webhook",
] as const;

/**
 * How far a channel may be trusted to carry an interaction.
 *
 * Ordered, and the order is load-bearing: `maximumInteractionMode` on a
 * capability set is a ceiling, and `narrowInteractionMode` can only move
 * down it. A channel that can only ring a doorbell must never be talked into
 * opening the door because some other input said "interactive".
 */
export type ChannelInteractionMode =
  | "none"
  | "notify"
  | "rendezvous"
  | "interactive";

const INTERACTION_ORDER: readonly ChannelInteractionMode[] = [
  "none",
  "notify",
  "rendezvous",
  "interactive",
] as const;

export function interactionRank(mode: ChannelInteractionMode): number {
  return INTERACTION_ORDER.indexOf(mode);
}

/** The weaker of two modes. The only way capabilities ever combine. */
export function narrowInteractionMode(
  a: ChannelInteractionMode,
  b: ChannelInteractionMode,
): ChannelInteractionMode {
  return interactionRank(a) <= interactionRank(b) ? a : b;
}

/**
 * What a notification body may contain on a given surface.
 *
 * A lock screen, an archived Slack workspace, a compliance export and a
 * watch face are all "the notification". `minimal` is what any of them may
 * hold: that something is being asked, and nothing about what.
 */
export type NotificationConfidentiality = "minimal" | "descriptive" | "full";

/**
 * A channel's closed capability record.
 *
 * Closed on purpose. Scattering booleans at call sites is how a system ends
 * up with one code path that forgot to ask whether the channel could really
 * verify its user; a single record that every decision reads from cannot
 * develop that kind of hole.
 */
export interface ChannelCapabilities {
  kind: NotificationChannelKind;
  /** Can put a message in front of a person at all. */
  canNotify: boolean;
  /** Can carry an opaque link back into an OpenSesame ceremony. */
  canRendezvous: boolean;
  /** Can receive callbacks whose provenance we can cryptographically check. */
  canReceiveAuthenticatedCallback: boolean;
  /** Can render approve/deny affordances in the message itself. */
  canRenderDecisionActions: boolean;
  /** A binding names a stable provider subject, not a display string. */
  bindsExternalIdentity: boolean;
  /** A binding names a provider tenant/workspace as well as a subject. */
  bindsProviderTenant: boolean;
  /** The provider tells us, verifiably, that the human acted. */
  verifiesUserPresence: boolean;
  /** The provider verifies *which* human — biometrics, PIN, re-auth. */
  supportsUserVerification: boolean;
  /** The callback can be tied to one specific transaction, not just "a click". */
  supportsTransactionBinding: boolean;
  /** Can ever satisfy `requirePhishingResistance`. Almost nothing can. */
  canSatisfyPhishingResistance: boolean;
  /** Can ask the person to transcribe a comparison value. */
  supportsComparisonEntry: boolean;
  /**
   * The provider stamps its callbacks with a time we can check.
   *
   * Slack signs a timestamp into the string it MACs; WeChat's signature
   * covers one. The Telegram Bot API stamps a button press with nothing at
   * all. A channel without this must establish freshness some other way — in
   * practice a one-time server-minted reference — and `evaluateDirectSettlement`
   * refuses rather than accepting a caller's word for it.
   */
  attestsCallbackTimestamp: boolean;
  /** Can revise or withdraw a message it already sent. */
  supportsNotificationUpdate: boolean;
  /** Strongest device binding this channel can ever evidence. */
  maximumDeviceBinding: DeviceBinding;
  /** Strongest key protection this channel can ever evidence. */
  maximumKeyProtection: KeyProtection;
  /** Strongest user verification this channel can ever evidence. */
  maximumUserVerification: UserVerification;
  /** What a body on this surface may disclose. */
  confidentiality: NotificationConfidentiality;
  /** Ceiling on how far this channel may be trusted to carry a decision. */
  maximumInteractionMode: ChannelInteractionMode;
}

/**
 * The capability catalogue.
 *
 * These are claims about what the adapters in this repository can actually
 * demonstrate, not about what a vendor's marketing page says is possible. A
 * capability set that overstates its adapter is a lie the policy engine will
 * faithfully act on, so `packages/os-domain/src/__tests__` and each adapter's
 * own suite hold this table to what the code does.
 *
 * Note what is uniformly false: `canSatisfyPhishingResistance`. Phishing
 * resistance is a property of a credential bound to an origin, and no chat
 * app, push notification or text message is one. NIST SP 800-63B treats
 * out-of-band authenticators as exactly this — useful, rate-limited, and not
 * phishing-resistant — and a preference for Telegram cannot change physics.
 */
/** The catalogue's shape: every channel kind, exactly once. */
export type ChannelCapabilityCatalogue = {
  readonly [kind in NotificationChannelKind]: ChannelCapabilities;
};

export const CHANNEL_CAPABILITIES: ChannelCapabilityCatalogue = {
  /**
   * The durable inbox. The only surface where an OpenSesame ceremony can
   * run, so it is the only one whose ceiling is `interactive` *and* whose
   * phishing resistance can be satisfied — by the WebAuthn activation that
   * runs inside it, never by the channel itself.
   */
  in_app: {
    kind: "in_app",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: true,
    canRenderDecisionActions: true,
    bindsExternalIdentity: false,
    bindsProviderTenant: false,
    verifiesUserPresence: true,
    supportsUserVerification: true,
    supportsTransactionBinding: true,
    canSatisfyPhishingResistance: true,
    supportsComparisonEntry: true,
    attestsCallbackTimestamp: true,
    supportsNotificationUpdate: true,
    maximumDeviceBinding: "hardware",
    maximumKeyProtection: "external_hardware",
    maximumUserVerification: "local_user_verification",
    confidentiality: "full",
    maximumInteractionMode: "interactive",
  },
  /**
   * W3C Push. The subscription is bound to a device, but a push endpoint is
   * a delivery address: possession of it is not a person. It rings and links.
   *
   * It cannot revise a message it already delivered. The `Topic` header
   * replaces an *undelivered* push still queued at the push service, which is
   * a different thing, and needs the subscription rather than a message
   * handle. Claiming otherwise would have the worker try to withdraw a
   * settled request's banner and quietly fail.
   */
  native_push: {
    kind: "native_push",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: false,
    canRenderDecisionActions: false,
    bindsExternalIdentity: false,
    bindsProviderTenant: false,
    verifiesUserPresence: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: false,
    supportsNotificationUpdate: false,
    maximumDeviceBinding: "software",
    maximumKeyProtection: "software_non_exportable",
    maximumUserVerification: "none",
    confidentiality: "minimal",
    maximumInteractionMode: "rendezvous",
  },
  /**
   * Slack. The one external channel here whose interactive callbacks have an
   * official, checkable provenance mechanism (v0 request signing over the raw
   * body, with a timestamp window), and whose identity is a stable
   * team-id + user-id pair rather than an email address. That earns it an
   * `interactive` ceiling — which is a ceiling, not a default: direct
   * approval still requires policy to say so per channel.
   */
  slack: {
    kind: "slack",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: true,
    canRenderDecisionActions: true,
    bindsExternalIdentity: true,
    bindsProviderTenant: true,
    verifiesUserPresence: true,
    supportsUserVerification: false,
    supportsTransactionBinding: true,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: true,
    supportsNotificationUpdate: true,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "descriptive",
    maximumInteractionMode: "interactive",
  },
  /**
   * Microsoft Teams. Outgoing notification is honest and complete; inbound
   * action provenance needs a Bot Framework channel with a hosted, publicly
   * reachable messaging endpoint and an Entra app registration whose token
   * validation this repository cannot exercise without standing that service
   * up. Rather than accept an unverifiable POST as a human decision, the
   * ceiling is `rendezvous` and direct approval is declared unsupported.
   */
  teams: {
    kind: "teams",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: false,
    canRenderDecisionActions: false,
    bindsExternalIdentity: true,
    bindsProviderTenant: true,
    verifiesUserPresence: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: false,
    supportsNotificationUpdate: false,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "descriptive",
    maximumInteractionMode: "rendezvous",
  },
  /**
   * Telegram. Bot API updates arrive with a secret token the bot chose, and
   * callback data is ours to make opaque and one-time, so provenance and
   * transaction binding are both checkable. Identity is the numeric user id
   * established in the binding ceremony — never the mutable @username.
   */
  telegram: {
    kind: "telegram",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: true,
    canRenderDecisionActions: true,
    bindsExternalIdentity: true,
    bindsProviderTenant: false,
    verifiesUserPresence: true,
    supportsUserVerification: false,
    supportsTransactionBinding: true,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: false,
    supportsNotificationUpdate: true,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "descriptive",
    maximumInteractionMode: "interactive",
  },
  /**
   * WeChat. The Official Account message callback is signature-checkable, so
   * a notification and a rendezvous are honest. An interactive approval would
   * additionally need a verified service account and a per-user OpenID
   * obtained through an authorization flow this repository cannot exercise
   * offline, so the ceiling stops at `rendezvous`.
   */
  wechat: {
    kind: "wechat",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: true,
    canRenderDecisionActions: false,
    bindsExternalIdentity: true,
    bindsProviderTenant: true,
    verifiesUserPresence: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: true,
    supportsNotificationUpdate: false,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "minimal",
    maximumInteractionMode: "rendezvous",
  },
  /**
   * SMS. A phone number is a lease from a carrier, not an identity: SIM swap
   * and number reassignment both transfer it without the holder's
   * involvement. It notifies and it links, and it is deliberately incapable
   * of more.
   */
  sms: {
    kind: "sms",
    canNotify: true,
    canRendezvous: true,
    canReceiveAuthenticatedCallback: false,
    canRenderDecisionActions: false,
    bindsExternalIdentity: true,
    bindsProviderTenant: false,
    verifiesUserPresence: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: false,
    supportsNotificationUpdate: false,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "minimal",
    maximumInteractionMode: "rendezvous",
  },
  /**
   * A signed webhook. Integration plumbing: an endpoint is a program, not a
   * person, and no amount of correct HMAC makes it one. It notifies.
   */
  webhook: {
    kind: "webhook",
    canNotify: true,
    canRendezvous: false,
    canReceiveAuthenticatedCallback: false,
    canRenderDecisionActions: false,
    bindsExternalIdentity: false,
    bindsProviderTenant: false,
    verifiesUserPresence: false,
    supportsUserVerification: false,
    supportsTransactionBinding: false,
    canSatisfyPhishingResistance: false,
    supportsComparisonEntry: false,
    attestsCallbackTimestamp: false,
    supportsNotificationUpdate: false,
    maximumDeviceBinding: "none",
    maximumKeyProtection: "unknown",
    maximumUserVerification: "none",
    confidentiality: "minimal",
    maximumInteractionMode: "notify",
  },
} as const;

export function channelCapabilities(
  kind: NotificationChannelKind,
): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[kind];
}

/**
 * The authentication facts an external channel ceremony may contribute.
 *
 * Deliberately a *ceiling*, derived from the capability record rather than
 * from anything the provider said about itself. A callback cannot assert it
 * was phishing-resistant; the strongest it can do is be delivered, and this
 * function is what turns "delivered" into the small set of facts that is
 * worth. Missing facts stay missing, so the evaluator fails closed.
 */
export function channelAuthenticationCeiling(
  kind: NotificationChannelKind,
  at: Date,
): AuthenticationFacts {
  const caps = channelCapabilities(kind);
  return {
    authenticatedAt: at,
    ...(caps.supportsUserVerification ? { userVerifiedAt: at } : undefined),
    methods: [`channel:${kind}`],
    factorCount: caps.verifiesUserPresence ? 1 : 0,
    userVerification: caps.maximumUserVerification,
    phishingResistant: caps.canSatisfyPhishingResistance,
    verifierNameBound: false,
    deviceBinding: caps.maximumDeviceBinding,
    keyProtection: caps.maximumKeyProtection,
    syncability: "unknown",
  };
}

/* ------------------------------------------------------------------ *
 * External channel bindings
 * ------------------------------------------------------------------ */

export type ChannelBindingState = "pending" | "active" | "revoked" | "expired";

/**
 * How a binding came to be believed. Recorded because "we sent a message to
 * this address and something came back" and "the provider's OAuth install
 * flow named this subject in this tenant" are not the same evidence, and a
 * later reviewer needs to be able to tell which one happened.
 */
export type ChannelBindingVerification =
  | "provider_oauth_install"
  | "provider_callback_challenge"
  | "push_subscription"
  | "operator_provisioned";

/**
 * A durable association between an OpenSesame principal and somewhere a
 * notification can be delivered.
 *
 * The authority-bearing fields are `providerId`, `providerTenantId` and
 * `providerSubjectId` — a stable tuple. Display metadata is carried in
 * `displayLabel` and is explicitly *not* authority: an email address, a
 * @username and a display name are all things another person can come to own
 * without anyone's involvement, and a system that resolves approvers by them
 * hands the binding over with them. See `docs/identity-linking.md`, which
 * already draws this line for identity; this is the same line for delivery.
 */
export interface ExternalChannelBinding {
  id: string;
  principalId: PrincipalId;
  kind: NotificationChannelKind;
  /** Issuer/provider identifier, e.g. `slack`, `telegram`, a push origin. */
  providerId: string;
  /** Workspace/tenant/account. Empty string where the provider has none. */
  providerTenantId: string;
  /** Stable provider subject. Never a display name, handle, or address. */
  providerSubjectId: string;
  /** Non-authoritative, for showing the person which destination this is. */
  displayLabel?: string;
  state: ChannelBindingState;
  verification: ChannelBindingVerification;
  createdAt: Date;
  verifiedAt?: Date;
  revokedAt?: Date;
  expiresAt?: Date;
  /** Digest-shaped, never secret material. */
  metadata: JsonObject;
  version: number;
}

/** Active means active *now*: a lapsed binding is not a live destination. */
export function isBindingUsable(
  binding: ExternalChannelBinding,
  now: Date,
): boolean {
  if (binding.state !== "active") return false;
  if (binding.revokedAt) return false;
  if (binding.expiresAt && binding.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/**
 * Does a callback's claimed provider identity match this binding?
 *
 * All three components, exactly. The cross-tenant case is the interesting
 * one: provider subject ids are unique within a tenant, not across them, so
 * comparing the subject alone lets an attacker who controls their own
 * workspace mint a "matching" identity for somebody else's binding.
 */
export function bindingMatchesProviderIdentity(
  binding: ExternalChannelBinding,
  claimed: {
    providerId: string;
    providerTenantId: string;
    providerSubjectId: string;
  },
): boolean {
  return (
    binding.providerId === claimed.providerId &&
    binding.providerTenantId === claimed.providerTenantId &&
    binding.providerSubjectId === claimed.providerSubjectId &&
    binding.providerSubjectId.length > 0
  );
}

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

/**
 * What kind of thing is being announced. Preferences are per-class because
 * "tell me about security events everywhere" and "only ping me once about
 * approvals" are different wishes.
 */
export type NotificationClass =
  | "authorization_request"
  | "authorization_decision"
  | "security_event";

export const NOTIFICATION_CLASSES: readonly NotificationClass[] = [
  "authorization_request",
  "authorization_decision",
  "security_event",
] as const;

export interface NotificationPreference {
  /** Ordered. First is most preferred; later entries are the fallback ladder. */
  channels: NotificationChannelKind[];
  /**
   * Deliver to every eligible channel rather than stopping at the first that
   * accepts. Reasonable for `security_event`, noisy for approvals.
   */
  fanOut: boolean;
}

export interface NotificationPreferences {
  principalId: PrincipalId;
  byClass: { [cls in NotificationClass]?: NotificationPreference };
  updatedAt: Date;
  version: number;
}

export const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  channels: ["in_app"],
  fanOut: false,
};

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

/**
 * A coarse label, for choosing a policy and for wording a screen. It is not
 * the gate: the gate is `requiredAssurance` plus the explicit switches below.
 * Deriving security from a string like "high" is how a rename becomes a
 * privilege change.
 */
export type ApprovalRiskClass = "low" | "moderate" | "high" | "critical";

/**
 * The operator's rules for one class of authorization transaction.
 *
 * `allowedChannels` is the outer bound on where a prompt may go and
 * `directApprovalChannels` — always a subset — on which of those may settle
 * a decision by themselves. Both default to their most conservative value in
 * `defaultApprovalPolicy`, because a policy that has not thought about a
 * channel has not permitted it.
 */
export interface ApprovalPolicy {
  id: string;
  riskClass: ApprovalRiskClass;
  /** The real gate, evaluated by `@opensesame/trust-broker`. */
  requiredAssurance: AssuranceRequirement;
  /** Where a prompt for this class may be delivered at all. */
  allowedChannels: NotificationChannelKind[];
  /** Which of those may carry a decision. Subset of `allowedChannels`. */
  directApprovalChannels: NotificationChannelKind[];
  /** Which may carry a *denial*. Denial is cheaper, but it is not free. */
  directDenialChannels: NotificationChannelKind[];
  /** Require a fresh WebAuthn activation bound to this exact transaction. */
  requireTransactionBoundActivation: boolean;
  /** Require the approver to transcribe a server-generated comparison value. */
  requireComparison: boolean;
  /** How stale an activation may be when it is spent, in seconds. */
  maximumApprovalAgeSeconds: number;
  /** What an external notification body may disclose for this class. */
  maximumNotificationConfidentiality: NotificationConfidentiality;
}

/**
 * The safe policy. Everything a caller did not think about lands here:
 * notify anywhere the person has chosen, settle nowhere but in-app, and
 * prove it with a transaction-bound authenticator.
 */
export function defaultApprovalPolicy(
  riskClass: ApprovalRiskClass = "high",
): ApprovalPolicy {
  const base: ApprovalPolicy = {
    id: `policy:default:${riskClass}`,
    riskClass,
    requiredAssurance: {
      subjectKind: "human",
      requireUserVerification: true,
      requirePhishingResistance: true,
      requireVerifierNameBinding: true,
      maximumAuthenticationAgeSeconds: 300,
    },
    allowedChannels: [...NOTIFICATION_CHANNEL_KINDS],
    directApprovalChannels: [],
    directDenialChannels: [],
    requireTransactionBoundActivation: true,
    requireComparison: false,
    maximumApprovalAgeSeconds: 300,
    maximumNotificationConfidentiality: "minimal",
  };
  if (riskClass === "critical") {
    return { ...base, requireComparison: true, maximumApprovalAgeSeconds: 120 };
  }
  if (riskClass === "moderate") {
    return {
      ...base,
      requiredAssurance: {
        subjectKind: "human",
        requireUserVerification: true,
        maximumAuthenticationAgeSeconds: 900,
      },
      maximumNotificationConfidentiality: "descriptive",
    };
  }
  if (riskClass === "low") {
    return {
      ...base,
      requiredAssurance: { subjectKind: "human" },
      requireTransactionBoundActivation: false,
      maximumApprovalAgeSeconds: 900,
      maximumNotificationConfidentiality: "descriptive",
    };
  }
  return base;
}

/**
 * Repair a policy that permits more than it can mean.
 *
 * Called on every policy before it is used, so a hand-written or
 * operator-supplied policy cannot express "direct approval on a channel that
 * is not even allowed to receive the prompt", or "settle from a channel
 * whose adapter cannot authenticate a callback". The invariant is
 * structural: the rest of the system reads the normalized value and does not
 * have to remember to re-check.
 */
export function normalizeApprovalPolicy(
  policy: ApprovalPolicy,
): ApprovalPolicy {
  const allowed = policy.allowedChannels.filter((kind) =>
    NOTIFICATION_CHANNEL_KINDS.includes(kind),
  );
  const settleable = (kinds: NotificationChannelKind[]) =>
    kinds.filter((kind) => {
      if (!allowed.includes(kind)) return false;
      const caps = channelCapabilities(kind);
      return (
        caps.canReceiveAuthenticatedCallback &&
        caps.canRenderDecisionActions &&
        caps.bindsExternalIdentity &&
        caps.supportsTransactionBinding &&
        interactionRank(caps.maximumInteractionMode) >=
          interactionRank("interactive")
      );
    });
  return {
    ...policy,
    allowedChannels: allowed,
    directApprovalChannels: settleable(policy.directApprovalChannels),
    directDenialChannels: settleable(policy.directDenialChannels),
  };
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

export type ChannelIneligibilityReason =
  | "not_allowed_by_policy"
  | "no_active_binding"
  | "adapter_unavailable"
  | "cannot_notify"
  | "not_preferred";

export interface ChannelRouteStep {
  kind: NotificationChannelKind;
  bindingId?: string;
  /** How far this step may go. Never above the channel's own ceiling. */
  mode: ChannelInteractionMode;
  confidentiality: NotificationConfidentiality;
}

export interface RoutePlan {
  /** Ordered. Without fan-out, later steps are tried only if earlier fail. */
  steps: ChannelRouteStep[];
  fanOut: boolean;
  /** Why each excluded channel was excluded — for an honest settings screen. */
  excluded: {
    kind: NotificationChannelKind;
    reason: ChannelIneligibilityReason;
  }[];
}

export interface RouteInput {
  policy: ApprovalPolicy;
  preference: NotificationPreference;
  bindings: ExternalChannelBinding[];
  /** Channel kinds whose adapter is actually configured on this deployment. */
  availableChannels: readonly NotificationChannelKind[];
  now: Date;
}

/**
 * Where this prompt goes.
 *
 * The composition is an intersection and it is ordered so that no input can
 * widen another:
 *
 *   policy ∩ preference ∩ live bindings ∩ configured adapters
 *
 * `in_app` is appended unconditionally. The durable inbox is the authority;
 * every other step is a way of telling somebody to go look at it, and a
 * person whose every channel is misconfigured must still be able to find the
 * request waiting for them.
 */
export function planNotificationRoute(input: RouteInput): RoutePlan {
  const policy = normalizeApprovalPolicy(input.policy);
  const excluded: RoutePlan["excluded"] = [];
  const steps: ChannelRouteStep[] = [];
  const seen = new Set<NotificationChannelKind>();

  const usableBindings = input.bindings.filter((b) =>
    isBindingUsable(b, input.now),
  );

  // Preference order, filtered. Iterating the *preference* rather than the
  // policy is what makes ordering a user affordance while membership stays
  // the operator's; a preference for a channel policy never allowed simply
  // finds nothing to select.
  for (const kind of input.preference.channels) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    if (kind === "in_app") continue; // appended below, always.
    const caps = channelCapabilities(kind);
    if (!policy.allowedChannels.includes(kind)) {
      excluded.push({ kind, reason: "not_allowed_by_policy" });
      continue;
    }
    if (!caps.canNotify) {
      excluded.push({ kind, reason: "cannot_notify" });
      continue;
    }
    if (!input.availableChannels.includes(kind)) {
      // No adapter configured. Reporting this rather than silently dropping
      // it is the difference between a settings screen that is honest about
      // being unconfigured and one that claims a channel is working.
      excluded.push({ kind, reason: "adapter_unavailable" });
      continue;
    }
    const binding = usableBindings.find((b) => b.kind === kind);
    if (caps.bindsExternalIdentity && !binding) {
      excluded.push({ kind, reason: "no_active_binding" });
      continue;
    }
    steps.push({
      kind,
      ...(binding ? { bindingId: binding.id } : undefined),
      // A step is never stronger than both the channel and the policy allow.
      mode: narrowInteractionMode(
        caps.maximumInteractionMode,
        policy.directApprovalChannels.includes(kind) ||
          policy.directDenialChannels.includes(kind)
          ? "interactive"
          : "rendezvous",
      ),
      confidentiality: leastConfidentiality(
        caps.confidentiality,
        policy.maximumNotificationConfidentiality,
      ),
    });
  }

  for (const kind of policy.allowedChannels) {
    if (seen.has(kind) || kind === "in_app") continue;
    excluded.push({ kind, reason: "not_preferred" });
  }

  steps.push({
    kind: "in_app",
    mode: "interactive",
    confidentiality: "full",
  });

  return { steps, fanOut: input.preference.fanOut, excluded };
}

const CONFIDENTIALITY_ORDER: readonly NotificationConfidentiality[] = [
  "minimal",
  "descriptive",
  "full",
] as const;

export function leastConfidentiality(
  a: NotificationConfidentiality,
  b: NotificationConfidentiality,
): NotificationConfidentiality {
  return CONFIDENTIALITY_ORDER.indexOf(a) <= CONFIDENTIALITY_ORDER.indexOf(b)
    ? a
    : b;
}

/* ------------------------------------------------------------------ *
 * Direct external settlement
 * ------------------------------------------------------------------ */

/**
 * How a callback's freshness was established.
 *
 * Named rather than reduced to a boolean, because the two mechanisms have
 * different failure modes and only one of them is available on any given
 * channel. `provider_timestamp` is a signed time inside the provider's own
 * MAC. `one_time_reference` is a server-minted opaque token that the replay
 * ledger retires on first use — which is what a channel that stamps nothing,
 * like a Telegram button press, must rely on instead. `none` is a caller who
 * could not establish either, and is refused.
 */
export type CallbackFreshnessSource =
  | "provider_timestamp"
  | "one_time_reference"
  | "none";

export type DirectSettlementRefusal =
  | "channel_not_permitted_by_policy"
  | "channel_cannot_settle"
  | "binding_not_usable"
  | "binding_identity_mismatch"
  | "callback_not_authenticated"
  | "callback_stale"
  | "callback_freshness_unestablished"
  | "callback_replayed"
  | "request_not_pending"
  | "request_digest_changed"
  | "activation_required"
  | "comparison_required";

export interface DirectSettlementInput {
  decision: "approved" | "denied";
  kind: NotificationChannelKind;
  policy: ApprovalPolicy;
  binding?: ExternalChannelBinding;
  claimedIdentity?: {
    providerId: string;
    providerTenantId: string;
    providerSubjectId: string;
  };
  /** The adapter verified the provider's own signature/token over raw bytes. */
  callbackAuthenticated: boolean;
  /** The adapter's freshness window accepted the callback's timestamp. */
  callbackFresh: boolean;
  /**
   * Which mechanism established that freshness. Checked against the channel's
   * capabilities below, so a caller cannot claim a provider timestamp on a
   * channel whose provider does not send one.
   */
  freshnessSource: CallbackFreshnessSource;
  /** The replay ledger had not seen this callback before. */
  callbackUnseen: boolean;
  requestPending: boolean;
  /** The digest the callback names equals the stored one. */
  requestDigestMatches: boolean;
  comparisonSatisfied: boolean;
  now: Date;
}

export interface DirectSettlementDecision {
  permitted: boolean;
  refusals: DirectSettlementRefusal[];
}

/**
 * May this external callback settle the request by itself?
 *
 * Default deny, and every clause is a conjunction: the function collects
 * refusals rather than returning on the first, so an operator debugging a
 * channel sees all of what is wrong, but `permitted` is true only when the
 * list is empty.
 *
 * The clause worth staring at is the assurance one, which is *not* here: an
 * authentic callback tells us the message came from Slack, and nothing at
 * all about whether the person at the other end satisfied
 * `requirePhishingResistance`. That is `@opensesame/trust-broker`'s job, and
 * the caller must pass both gates. Splitting them is deliberate — a single
 * function that conflated "the provider signed it" with "the human proved
 * themselves" is precisely the confused deputy this design exists to avoid.
 */
export function evaluateDirectSettlement(
  input: DirectSettlementInput,
): DirectSettlementDecision {
  const policy = normalizeApprovalPolicy(input.policy);
  const refusals: DirectSettlementRefusal[] = [];
  const caps = channelCapabilities(input.kind);

  const permittedChannels =
    input.decision === "approved"
      ? policy.directApprovalChannels
      : policy.directDenialChannels;
  if (!permittedChannels.includes(input.kind)) {
    refusals.push("channel_not_permitted_by_policy");
  }
  if (
    interactionRank(caps.maximumInteractionMode) <
    interactionRank("interactive")
  ) {
    refusals.push("channel_cannot_settle");
  }
  if (!input.binding || !isBindingUsable(input.binding, input.now)) {
    refusals.push("binding_not_usable");
  } else if (
    !input.claimedIdentity ||
    !bindingMatchesProviderIdentity(input.binding, input.claimedIdentity)
  ) {
    refusals.push("binding_identity_mismatch");
  }
  if (!input.callbackAuthenticated) refusals.push("callback_not_authenticated");
  if (!input.callbackFresh) refusals.push("callback_stale");
  // Freshness must come from somewhere real. A caller asserting
  // `provider_timestamp` on a channel that stamps nothing is describing a
  // check that did not happen, and "none" is saying so outright — both are
  // the same refusal, because a replayed decision is the prize.
  if (
    input.freshnessSource === "none" ||
    (input.freshnessSource === "provider_timestamp" &&
      !caps.attestsCallbackTimestamp)
  ) {
    refusals.push("callback_freshness_unestablished");
  }
  if (!input.callbackUnseen) refusals.push("callback_replayed");
  if (!input.requestPending) refusals.push("request_not_pending");
  if (!input.requestDigestMatches) refusals.push("request_digest_changed");
  // A channel can never run a WebAuthn ceremony, so a policy that wants one
  // has, by saying so, ruled out settling anywhere but in-app.
  if (policy.requireTransactionBoundActivation) {
    refusals.push("activation_required");
  }
  if (policy.requireComparison && !input.comparisonSatisfied) {
    refusals.push("comparison_required");
  }
  return { permitted: refusals.length === 0, refusals };
}
