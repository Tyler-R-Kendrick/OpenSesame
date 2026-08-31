/**
 * The channel adapter contract (ADR 0084).
 *
 * One interface, seven providers, and the interface is deliberately smaller
 * than any of them. An adapter may render a message, hand it to a provider,
 * and — where the provider offers a checkable signature — say who a callback
 * came from. It may not decide anything. Settlement lives in
 * `@opensesame/os-domain`'s `evaluateDirectSettlement`, which is fed the
 * facts an adapter produced rather than the adapter's opinion of them, so a
 * new provider cannot introduce a new way to say yes.
 *
 * Two seams keep this testable and keep it honest:
 *
 * - **All HTTP goes through an injected `fetch`.** Nothing in this package
 *   opens a socket at module scope, so the whole suite runs offline and a
 *   deployment that forgot to configure a provider fails loudly rather than
 *   reaching out to whatever a hostile config pointed it at.
 * - **Provenance is checked over raw bytes.** Every signature scheme here
 *   signs the exact octets the provider sent. A verifier that re-serializes
 *   a parsed body before checking the MAC is verifying a document the
 *   provider never signed, and JSON round-trips are not identity.
 */

import type {
  ChannelCapabilities,
  JsonObject,
  NotificationChannelKind,
  NotificationClass,
  NotificationConfidentiality,
} from "@opensesame/os-domain";

/**
 * The HTTP seam. Shaped as the platform `fetch` so production passes the
 * global and tests pass a recorder — no module mocking, no interceptors.
 */
export type FetchLike = typeof fetch;

/** The clock seam. Freshness windows are only testable against a fixed one. */
export type ClockLike = () => Date;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Everything an adapter is allowed to know about a request it is announcing.
 *
 * Note what is *absent*, and note that the absence is the security control
 * rather than a convention: there is no field for a comparison code. ADR
 * 0046's number-matching value exists to prove the approver is looking at
 * the initiating surface, so putting it in the message that points at that
 * surface would hand both halves of the ceremony to whoever reads the
 * notification. A rule saying "don't render it" is a rule somebody forgets;
 * a type with nowhere to put it cannot be forgotten.
 *
 * `bindingMessage`, `actionLabel` and `requesterLabel` are requester-supplied
 * and therefore hostile until `sanitizeUntrustedText` has been over them.
 */
export interface RenderInput {
  kind: NotificationChannelKind;
  /** Already reduced by the router to the step's ceiling. Never widened here. */
  confidentiality: NotificationConfidentiality;
  notificationClass: NotificationClass;
  /** Machine-readable event identity, mirrored to endpoint-routed channels. */
  eventType: string;
  /**
   * The opaque handle a person quotes to find this request again. Opaque on
   * purpose: it is a rendezvous, not a capability, and it appears on lock
   * screens and in chat archives.
   */
  rendezvousRef: string;
  /** Absolute URL of the in-app ceremony. Carries no token of its own. */
  rendezvousUrl?: string;
  /** Requester-supplied. Untrusted. Rendered at `descriptive` and above. */
  bindingMessage?: string;
  /** Requester-supplied short verb. Untrusted. `descriptive` and above. */
  actionLabel?: string;
  /** Non-authoritative requester name. Untrusted. `full` only. */
  requesterLabel?: string;
  /** RFC 9396 details. `full` only — an external surface never sees these. */
  authorizationDetails?: readonly JsonObject[];
  /**
   * One-time, server-minted tokens that stand in for a decision on channels
   * that can carry one. Opaque by construction: an authorization request id
   * in a `callback_data` field is a request id in every chat backup and
   * every provider's logs, and it is guessable across requests.
   */
  decisionTokens?: DecisionTokens;
  /** Digest-shaped payload for endpoint-routed channels. Never prose. */
  eventPayload?: JsonObject;
  expiresAt?: Date;
}

export interface DecisionTokens {
  approve: string;
  deny: string;
}

/**
 * A message reduced to the channel's confidentiality, ready to hand over.
 *
 * `body` is the human-readable text and is what the privacy tests assert
 * against; anything provider-shaped (blocks, cards, keyboards) is built
 * inside `deliver` from these fields, so there is exactly one place where a
 * body could acquire something it should not have.
 */
export interface RenderedMessage {
  kind: NotificationChannelKind;
  confidentiality: NotificationConfidentiality;
  title: string;
  body: string;
  rendezvousUrl?: string;
  decisionTokens?: DecisionTokens;
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/**
 * Where one message goes, discriminated by channel.
 *
 * A union rather than a bag of optional fields: an adapter handed the wrong
 * destination shape must be able to refuse it as a programming error instead
 * of silently reading `undefined` and posting somewhere unintended.
 */
export type DeliveryDestination =
  | SlackDestination
  | TelegramDestination
  | TeamsDestination
  | WeChatDestination
  | SmsDestination
  | WebPushDestination
  | WebhookDestination;

export interface SlackDestination {
  channel: "slack";
  /** Workspace id — `T…`. Half of the identity tuple; never a domain name. */
  teamId: string;
  /** Stable user id — `U…`. Never an email address or display name. */
  userId: string;
}

export interface TelegramDestination {
  channel: "telegram";
  /** Numeric chat id as a string. Never an @username: those are re-assignable. */
  chatId: string;
}

export interface TeamsDestination {
  channel: "teams";
  /** Overrides the operator default. An incoming-webhook URL is a bearer secret. */
  incomingWebhookUrl?: string;
}

export interface WeChatDestination {
  channel: "wechat";
  /** Per-Official-Account OpenID. Opaque, and scoped to one app id. */
  openId: string;
}

export interface SmsDestination {
  channel: "sms";
  /** E.164. A leased number, which is why this channel may only ring. */
  e164: string;
}

export interface WebPushDestination {
  channel: "native_push";
  subscription: PushSubscriptionRecord;
}

/** A W3C Push subscription as the browser hands it over, base64url throughout. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface PushSubscriptionKeys {
  /** Uncompressed P-256 point, 65 bytes. */
  p256dh: string;
  /** 16-byte authentication secret. */
  auth: string;
}

export interface WebhookDestination {
  channel: "webhook";
  endpointId: string;
  url: string;
  /** Per-endpoint `whsec_` secret. */
  secret: string;
  /** Unique per delivery; doubles as the receiver's idempotency key. */
  deliveryId: string;
}

/**
 * How a send ended, as a closed set.
 *
 * The distinction that matters is `retryable` vs `permanent`: a queue that
 * cannot tell them apart either hammers a provider that has told it to stop
 * or drops a notification because a load balancer hiccuped.
 */
export type DeliveryStatus =
  | "delivered"
  | "retryable"
  | "permanent"
  | "unconfigured";

/**
 * `error` is a classification, never a provider response body.
 *
 * Providers are happy to echo attacker-chosen text back in an error, and a
 * delivery row is read by operators and shipped to log sinks. Status codes
 * and known error names only — anything unrecognized collapses to a fixed
 * token rather than travelling as free text.
 */
export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** Provider handle for a message we may later revise or withdraw. */
  providerMessageRef?: string;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Callbacks
 * ------------------------------------------------------------------ */

/**
 * An inbound provider request, as bytes.
 *
 * `rawBody` is the body exactly as received — not a parse, not a
 * re-serialization. `headers` must be lowercased by the caller, because HTTP
 * header names are case-insensitive and a lookup that misses returns
 * `undefined`, which a careless verifier reads as "unsigned" and a careless
 * framework reads as "fine".
 */
export interface CallbackRequest {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string>>;
  /** Lowercased query parameters. WeChat signs these instead of the body. */
  query?: Readonly<Record<string, string>>;
  /** Verifier clock, injected so freshness windows are testable. */
  now?: Date;
}

/**
 * Why a callback was not believed.
 *
 * The MAC failures collapse into one reason on purpose. Distinguishing "your
 * signature was 3 bytes short" from "your signature was wrong" is a
 * forgery oracle; distinguishing "your timestamp is stale" is not, because
 * the timestamp is attacker-chosen plaintext they can already read.
 */
export type CallbackRefusal =
  | "unconfigured"
  | "missing_signature"
  | "malformed_signature"
  | "signature_mismatch"
  | "timestamp_missing"
  | "timestamp_malformed"
  | "timestamp_stale"
  | "timestamp_future"
  | "body_too_large"
  | "body_unparseable"
  | "identity_missing";

export interface CallbackRefused {
  ok: false;
  reason: CallbackRefusal;
}

/**
 * A callback whose provenance checked out.
 *
 * `ok: true` means one thing only: these bytes came from the provider we
 * share a secret with. It is not an approval, it is not an authentication of
 * the human, and the three identity fields are a *claim* to be matched
 * against a stored binding by `bindingMatchesProviderIdentity` — the tuple
 * must be compared whole, since provider subject ids are unique within a
 * tenant and not across them.
 */
export interface CallbackVerified {
  ok: true;
  providerId: string;
  /** Empty string where the provider has no tenant concept. */
  providerTenantId: string;
  /** Stable provider subject. Never an email, handle, or display name. */
  providerSubjectId: string;
  /** Digest of the provider's own delivery identity, for the replay ledger. */
  callbackDigest: string;
  /** Present only where the provider tells us *which* affordance was used. */
  decision?: "approved" | "denied";
  /** The one-time token the affordance carried, for the caller to resolve. */
  opaqueRef?: string;
  /**
   * The provider stamped a time and it fell inside this adapter's window.
   * `false` means the provider offers no timestamp at all — the caller must
   * then get freshness from the one-time token's own expiry, and must not
   * read the absence of a refusal as a fresh callback.
   */
  fresh: boolean;
}

export type CallbackVerification = CallbackRefused | CallbackVerified;

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export interface ChannelAdapter {
  kind: NotificationChannelKind;
  /** True only when the operator supplied working configuration. */
  isConfigured(): boolean;
  /**
   * The channel's capability record, taken from the os-domain catalogue and
   * never re-declared here. An adapter that wrote its own would be free to
   * claim more than the catalogue the policy engine reads, which is the one
   * way a capability check can be true and wrong at the same time.
   */
  capabilities(): ChannelCapabilities;
  render(input: RenderInput): RenderedMessage;
  deliver(
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome>;
  /** Verify provider provenance over raw bytes, then extract identity. */
  verifyCallback?(raw: CallbackRequest): CallbackVerification;
  /** Revise or withdraw a message after settlement, where supported. */
  update?(ref: string, msg: RenderedMessage): Promise<DeliveryOutcome>;
}

/** Refusal helper, so no adapter hand-writes the discriminant. */
export function refuse(reason: CallbackRefusal): CallbackRefused {
  return { ok: false, reason };
}

/**
 * Upper bound on a callback body before any parsing is attempted.
 *
 * A megabyte of JSON is not an interaction payload, and the cost of finding
 * out is a megabyte of parse. The cap is checked before the MAC too: hashing
 * unbounded attacker input is itself the denial of service.
 */
export const MAX_CALLBACK_BODY_BYTES = 128 * 1024;
