import { createHash } from "node:crypto";
import {
  type CallbackRequest,
  type ChannelAdapter,
  type CallbackVerification as PackageVerification,
  createSlackAdapter,
  createTelegramAdapter,
} from "@opensesame/notification-adapters";
import {
  type CallbackFreshnessSource,
  type NotificationChannelKind,
  channelCapabilities,
} from "@opensesame/os-domain";

/**
 * Provider callback provenance (ADR 0081).
 *
 * An adapter answers exactly two questions, and nothing else:
 *
 *   1. Did this byte sequence really come from the provider, recently?
 *   2. What stable identity and opaque transaction reference does it name?
 *
 * It answers neither "is this person allowed to approve" nor "is this
 * request still open" — those belong to `evaluateApprovalCeremony`, which
 * runs afterwards. Keeping the split sharp is what stops an adapter from
 * becoming a second, weaker authorization engine.
 *
 * Everything here works on the *raw* bytes. A signature checked against a
 * re-serialized body checks a different message than the one that arrived:
 * key order, numeric formatting and unicode escapes all survive JSON
 * round-tripping in ways the provider's MAC does not.
 */

export interface CallbackVerification {
  /** The provider's own signature or token checked out over the raw bytes. */
  authenticated: boolean;
  /** The provider's timestamp fell inside the adapter's freshness window. */
  fresh: boolean;
  /**
   * *How* freshness was established, checked downstream against what this
   * channel can actually attest. A boolean would let an adapter for a channel
   * that stamps nothing report "fresh" and be believed; naming the mechanism
   * makes that claim checkable, and an adapter that has no mechanism says
   * `none` and is refused.
   */
  freshnessSource: CallbackFreshnessSource;
  /**
   * The replay key: a digest of the provider's delivery identity.
   *
   * For Slack that is the v0 signature, which commits to the timestamp and to
   * every byte of the body — so a byte-identical replay produces a byte-
   * identical key and the ledger refuses it.
   */
  callbackDigest: string;
  /**
   * Why the adapter refused, in our own closed vocabulary.
   *
   * The wire answer to a refused callback is always the same generic ack — a
   * route that distinguished "bad MAC" from "stale timestamp" to its caller
   * would be telling a forger which attempts were close. This field never
   * reaches the caller; it exists so the audit trail can still tell an
   * operator whether their clock is wrong or their secret is.
   */
  refusal?: "callback_stale" | "callback_not_authenticated";
}

/** The claim a callback makes. None of it is believed without the checks above. */
export interface CallbackClaim {
  providerId: string;
  /** Empty string where the provider has no tenant concept. */
  providerTenantId: string;
  providerSubjectId: string;
  /** The opaque, MAC-addressed reference this deployment put in the message. */
  transactionRef: string;
  decision: "approved" | "denied";
}

export type CallbackHeaders = (name: string) => string | undefined;

export interface NotificationCallbackAdapter {
  kind: NotificationChannelKind;
  providerId: string;
  verify(input: {
    raw: Uint8Array;
    header: CallbackHeaders;
    now: Date;
  }): CallbackVerification;
  /** Never throws: a malformed body is `null`, not an exception. */
  parse(raw: Uint8Array): CallbackClaim | null;
}

export type NotificationCallbackAdapters = {
  [provider: string]: NotificationCallbackAdapter | undefined;
};

/**
 * The bridge onto `@opensesame/notification-adapters`.
 *
 * The provider crypto lives in that package and only there. A second Slack
 * verifier in this file would be a second thing to keep correct, and the one
 * that drifts is the one an attacker finds — so this adapts the package's
 * `verifyCallback` into the two-step shape the route wants rather than
 * re-deriving a MAC.
 *
 * The two-step split is kept deliberately. `verify` hands back only
 * provenance, `parse` only claims, and the route cannot call the second
 * without having called the first: the ordering that stops an unauthenticated
 * body from reaching a parser is expressed in the types rather than left to
 * whoever edits the handler next.
 */
function bridgeAdapter(
  adapter: ChannelAdapter,
  providerId: string,
): NotificationCallbackAdapter | undefined {
  const verifyCallback = adapter.verifyCallback;
  // A channel whose adapter has no verifier cannot receive a decision at all.
  // Teams, WeChat, SMS, Web Push and the generic webhook are all in this
  // position by design, and the route must answer for them exactly as it does
  // for a provider that does not exist.
  if (!verifyCallback) return undefined;

  // One verification per request, memoised on the raw bytes, so `parse` reads
  // what `verify` checked rather than running the provider's parser twice and
  // risking two different answers from one body.
  let lastRaw: Uint8Array | undefined;
  let lastResult: PackageVerification | undefined;

  const run = (raw: Uint8Array, header: CallbackHeaders, now: Date) => {
    if (lastRaw === raw && lastResult) return lastResult;
    lastRaw = raw;
    lastResult = verifyCallback({
      rawBody: raw,
      headers: collectHeaders(header),
      now,
    });
    return lastResult;
  };

  return {
    kind: adapter.kind,
    providerId,
    verify({ raw, header, now }) {
      const result = run(raw, header, now);
      if (!result.ok) {
        return {
          // Staleness is checked before the MAC, so a stale body is one whose
          // authenticity we never established. Reporting it as authentic —
          // which an earlier draft of this bridge did — would have been a
          // claim nothing checked.
          authenticated: false,
          fresh: false,
          freshnessSource: "none",
          refusal:
            result.reason === "timestamp_stale" ||
            result.reason === "timestamp_future"
              ? "callback_stale"
              : "callback_not_authenticated",
          // A refused callback must still be nameable in an audit line, and
          // the refusal reason is our own closed vocabulary rather than
          // anything the caller chose.
          callbackDigest: createHash("sha256")
            .update(`${providerId}\0refused\0`)
            .update(result.reason)
            .digest("hex"),
        };
      }
      return {
        authenticated: true,
        fresh: result.fresh,
        freshnessSource: freshnessSourceFor(adapter.kind, result),
        callbackDigest: result.callbackDigest,
      };
    },
    parse(raw) {
      // Only ever reads the memoised result of a verification that already
      // happened. With no prior `verify` for these bytes there is nothing to
      // parse, which is the fail-closed answer.
      const result = lastRaw === raw ? lastResult : undefined;
      if (!result?.ok) return null;
      if (!result.decision || !result.opaqueRef) return null;
      if (!result.providerSubjectId) return null;
      return {
        providerId,
        providerTenantId: result.providerTenantId,
        providerSubjectId: result.providerSubjectId,
        transactionRef: result.opaqueRef,
        decision: result.decision,
      };
    },
  };
}

/**
 * Which mechanism established freshness on this channel.
 *
 * Read from the capability record rather than from the callback, because a
 * callback claiming a provider timestamp on a channel whose provider sends
 * none is describing a check that did not happen. A channel that stamps
 * nothing falls back to the one-time reference the message carried, which the
 * replay ledger retires; with no such reference there is nothing left and the
 * answer is `none`, which `evaluateDirectSettlement` refuses.
 */
function freshnessSourceFor(
  kind: NotificationChannelKind,
  result: { fresh: boolean; opaqueRef?: string },
): CallbackFreshnessSource {
  if (channelCapabilities(kind).attestsCallbackTimestamp) {
    return result.fresh ? "provider_timestamp" : "none";
  }
  return result.opaqueRef ? "one_time_reference" : "none";
}

/** The header names every shipped verifier reads, lowercased. */
const CALLBACK_HEADER_NAMES = [
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-telegram-bot-api-secret-token",
  "content-type",
] as const;

/**
 * The header names every shipped verifier reads, closed rather than open.
 *
 * A dictionary keyed by arbitrary strings would let an unrelated header ride
 * into a provider's verifier; naming the set keeps what crosses that boundary
 * to what a verifier actually asked for.
 */
/**
 * The bag a verifier reads, built only from names we chose.
 *
 * Typed as the package's own parameter type rather than an ad-hoc dictionary,
 * so this stays one contract rather than two that can drift. The closed
 * `CALLBACK_HEADER_NAMES` list is what actually bounds it: an unrelated
 * inbound header cannot ride into a provider's verifier because nothing ever
 * copies one in.
 */
type CallbackHeaderBag = CallbackRequest["headers"];

function collectHeaders(header: CallbackHeaders): CallbackHeaderBag {
  const out: { [name: string]: string } = {};
  for (const name of CALLBACK_HEADER_NAMES) {
    const value = header(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The adapters this deployment can actually verify.
 *
 * A provider with no secret configured gets no adapter, so its callback route
 * answers exactly as it does for a provider that does not exist — an
 * unconfigured integration must not be distinguishable from an absent one.
 */
export interface NotificationAdapterConfig {
  slackSigningSecret: string;
  slackBotToken?: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
}

export function createNotificationCallbackAdapters(
  config: NotificationAdapterConfig,
) {
  const adapters: NotificationCallbackAdapters = {};
  if (config.slackSigningSecret) {
    const slack = bridgeAdapter(
      createSlackAdapter({
        signingSecret: config.slackSigningSecret,
        botToken: config.slackBotToken ?? "",
      }),
      "slack",
    );
    if (slack) adapters.slack = slack;
  }
  if (config.telegramBotToken && config.telegramWebhookSecret) {
    const telegram = bridgeAdapter(
      createTelegramAdapter({
        botToken: config.telegramBotToken,
        callbackSecretToken: config.telegramWebhookSecret,
      }),
      "telegram",
    );
    if (telegram) adapters.telegram = telegram;
  }
  return adapters;
}
