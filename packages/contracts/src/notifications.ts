import { z } from "zod";

/**
 * Wire contracts for notification channels and approval ceremonies (ADR 0081).
 *
 * Two rules shape every schema here:
 *
 * 1. A preference expresses *where a person wants to be interrupted*. Nothing
 *    a client can put in one of these bodies can widen what policy permits —
 *    the server intersects, and a channel the operator did not allow simply
 *    finds nothing to select.
 * 2. No secret crosses this boundary in either direction. A comparison value
 *    is submitted, never returned; a provider credential is written, never
 *    read back; an activation is addressed by an opaque id.
 */

export const NotificationChannelKindSchema = z.enum([
  "in_app",
  "native_push",
  "slack",
  "teams",
  "telegram",
  "wechat",
  "sms",
  "webhook",
]);

export const NotificationClassSchema = z.enum([
  "authorization_request",
  "authorization_decision",
  "security_event",
]);

export const ChannelBindingStateSchema = z.enum([
  "pending",
  "active",
  "revoked",
  "expired",
]);

/** What a channel can do, as the server computes it. Read-only to clients. */
export const ChannelCapabilitiesResponseSchema = z.object({
  kind: NotificationChannelKindSchema,
  canNotify: z.boolean(),
  canRendezvous: z.boolean(),
  canReceiveAuthenticatedCallback: z.boolean(),
  canRenderDecisionActions: z.boolean(),
  bindsExternalIdentity: z.boolean(),
  bindsProviderTenant: z.boolean(),
  supportsUserVerification: z.boolean(),
  supportsTransactionBinding: z.boolean(),
  canSatisfyPhishingResistance: z.boolean(),
  maximumInteractionMode: z.enum([
    "none",
    "notify",
    "rendezvous",
    "interactive",
  ]),
  confidentiality: z.enum(["minimal", "descriptive", "full"]),
  /** False until an operator has supplied working configuration. */
  configured: z.boolean(),
});

/**
 * A destination, as its owner sees it.
 *
 * The provider *subject* is deliberately absent. It is the authority-bearing
 * half of the binding and showing it back adds nothing a person can act on,
 * while giving anyone who obtains this response the value a forged callback
 * would need to claim.
 */
export const ChannelBindingResponseSchema = z.object({
  id: z.string(),
  kind: NotificationChannelKindSchema,
  providerId: z.string(),
  /** Non-authoritative. A display string, never used to resolve a binding. */
  displayLabel: z.string().optional(),
  state: ChannelBindingStateSchema,
  verification: z.string(),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});

export const BeginChannelBindingSchema = z.object({
  kind: NotificationChannelKindSchema,
  /** Shown to the person so they can tell two destinations apart. */
  displayLabel: z.string().max(120).optional(),
  /**
   * Channel-specific, bounded, and never trusted as identity: whatever is in
   * here is a hint for reaching the provider, and the binding is established
   * by what comes back through the provider, not by what was typed.
   */
  destinationHint: z.string().max(512).optional(),
});

export const BeginChannelBindingResponseSchema = z.object({
  challengeId: z.string(),
  /**
   * The one-time value the person carries to the provider. Returned exactly
   * once, in this response, and stored only as a digest.
   */
  nonce: z.string(),
  expiresAt: z.string().datetime(),
  /** Where to complete the ceremony, when the provider drives it. */
  authorizeUrl: z.string().url().optional(),
});

export const CompleteChannelBindingSchema = z.object({
  challengeId: z.string().min(8).max(256),
  nonce: z.string().min(8).max(512),
});

export const NotificationPreferenceSchema = z.object({
  /** Ordered: first is most preferred, the rest are the fallback ladder. */
  channels: z.array(NotificationChannelKindSchema).max(8),
  fanOut: z.boolean().default(false),
});

export const UpdateNotificationPreferencesSchema = z.object({
  byClass: z.record(NotificationClassSchema, NotificationPreferenceSchema),
});

export const NotificationPreferencesResponseSchema = z.object({
  byClass: z.record(NotificationClassSchema, NotificationPreferenceSchema),
  updatedAt: z.string().datetime(),
});

/**
 * What the effective route actually is, and why a channel is not in it.
 *
 * Exposed so a settings screen can be honest. A screen that lists Slack as a
 * destination while the deployment has no Slack adapter configured is lying
 * to the person about where their prompts will appear.
 */
export const EffectiveRouteResponseSchema = z.object({
  steps: z.array(
    z.object({
      kind: NotificationChannelKindSchema,
      mode: z.enum(["none", "notify", "rendezvous", "interactive"]),
      confidentiality: z.enum(["minimal", "descriptive", "full"]),
    }),
  ),
  fanOut: z.boolean(),
  excluded: z.array(
    z.object({
      kind: NotificationChannelKindSchema,
      reason: z.enum([
        "not_allowed_by_policy",
        "no_active_binding",
        "adapter_unavailable",
        "cannot_notify",
        "not_preferred",
      ]),
    }),
  ),
});

/* ------------------------------------------------------------------ *
 * Approval ceremony
 * ------------------------------------------------------------------ */

export const ApprovalDecisionSchema = z.enum(["approved", "denied"]);

/**
 * What the approver must do before this request can be settled.
 *
 * Sent to the review screen so the ceremony can be explicit rather than
 * one-tap: a person deserves to know *why* they are being asked to touch an
 * authenticator again.
 */
export const ApprovalRequirementResponseSchema = z.object({
  riskClass: z.enum(["low", "moderate", "high", "critical"]),
  policyDigest: z.string(),
  requireTransactionBoundActivation: z.boolean(),
  requireComparison: z.boolean(),
  /** Reason codes, not a scalar level. */
  required: z.array(z.string()),
  maximumApprovalAgeSeconds: z.number().int(),
  /** Which channel brought the approver here, when one did. */
  arrivedVia: NotificationChannelKindSchema.optional(),
});

export const BeginApprovalActivationSchema = z.object({
  decision: ApprovalDecisionSchema,
  /**
   * Echoed from what was displayed. An activation is minted against the
   * request the person actually read, so a request that changed in between
   * cannot be signed for.
   */
  requestDigest: z.string().min(16).max(256),
});

export const BeginApprovalActivationResponseSchema = z.object({
  activationId: z.string(),
  /** The digest the WebAuthn ceremony is bound to. Public, not secret. */
  transactionDigest: z.string(),
  policyDigest: z.string(),
  expiresAt: z.string().datetime(),
  /** SimpleWebAuthn-shaped request options. */
  options: z.record(z.string(), z.unknown()),
});

export const CompleteApprovalActivationSchema = z.object({
  activationId: z.string().min(8).max(256),
  credentialId: z.string().min(1).max(16384),
  clientDataJSON: z.string().min(1).max(16384),
  authenticatorData: z.string().min(1).max(16384),
  signature: z.string().min(1).max(16384),
});

/**
 * The decision body.
 *
 * `comparisonValue` is submitted and never echoed; `activationId` names a
 * ceremony the server already verified rather than carrying its proof again.
 */
export const SettleAuthorizationRequestSchema = z.object({
  requestDigest: z.string().min(16).max(256),
  activationId: z.string().min(8).max(256).optional(),
  comparisonValue: z
    .string()
    .regex(/^[0-9]{6}$/, "comparison value is six digits")
    .optional(),
});

/**
 * The comparison value, issued to the *initiating* surface.
 *
 * Deliberately not part of any notification body: the point of the ceremony
 * is that the person carries the value from where the request started to
 * where it is approved. A code that arrives in the same message as the
 * prompt compares nothing.
 */
export const ComparisonChallengeResponseSchema = z.object({
  authReqId: z.string(),
  value: z.string(),
  expiresAt: z.string().datetime(),
});

export const ApprovalReceiptResponseSchema = z.object({
  authReqId: z.string(),
  decision: ApprovalDecisionSchema,
  decidedByKind: z.enum(["human", "agent"]),
  path: z.enum(["in_app", "external_rendezvous", "external_direct", "agent"]),
  channelKind: NotificationChannelKindSchema,
  requestDigest: z.string(),
  transactionDigest: z.string(),
  policyDigest: z.string(),
  requiredAssurance: z.array(z.string()),
  achievedAssurance: z.array(z.string()),
  comparisonRequired: z.boolean(),
  comparisonSatisfied: z.boolean(),
  decidedAt: z.string().datetime(),
  receiptVersion: z.number().int(),
});

/* ------------------------------------------------------------------ *
 * Web Push subscriptions
 * ------------------------------------------------------------------ */

/**
 * A W3C Push subscription, as the browser produces it.
 *
 * The endpoint is a capability URL: anyone holding it can push to that
 * browser. It is stored, never returned, and never logged — which is why the
 * list response below names a subscription by an opaque id and a device
 * label instead.
 */
export const RegisterPushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
  deviceLabel: z.string().max(120).optional(),
});

export const PushSubscriptionResponseSchema = z.object({
  id: z.string(),
  deviceLabel: z.string().optional(),
  createdAt: z.string().datetime(),
});

export const PushPublicKeyResponseSchema = z.object({
  /** The VAPID application server public key, base64url. Public by design. */
  publicKey: z.string(),
});

export type BeginChannelBinding = z.infer<typeof BeginChannelBindingSchema>;
export type CompleteChannelBinding = z.infer<
  typeof CompleteChannelBindingSchema
>;
export type UpdateNotificationPreferences = z.infer<
  typeof UpdateNotificationPreferencesSchema
>;
export type SettleAuthorizationRequest = z.infer<
  typeof SettleAuthorizationRequestSchema
>;
export type RegisterPushSubscription = z.infer<
  typeof RegisterPushSubscriptionSchema
>;
