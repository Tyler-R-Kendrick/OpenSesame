/**
 * Slack — the one external channel here that can carry a decision.
 *
 * It earns that because Slack publishes a provenance mechanism we can
 * actually check offline: the v0 request signature, an HMAC-SHA256 over
 * `v0:{timestamp}:{raw body}` under a secret only the app and Slack hold,
 * with the timestamp inside the signed string so a captured request cannot
 * be replayed after the window closes. Everything below is arranged around
 * doing that check *first* and doing it over the bytes Slack signed.
 *
 * The identity we take from an interaction is `team.id` + `user.id`. Not the
 * email, not the `@handle`, not the display name: all three are mutable, two
 * of them are settable by the user, and any of them can come to belong to
 * somebody else while the binding row stays put. Slack's own ids do not move.
 *
 * What this adapter still does not do is authenticate the *human*. A valid
 * signature proves the bytes came from Slack. Whether the person behind them
 * met the assurance the operation demands is `@opensesame/trust-broker`'s
 * question, and `evaluateDirectSettlement` requires both answers.
 */

import { createHmac } from "node:crypto";

import {
  type ChannelCapabilities,
  type JsonObject,
  channelCapabilities,
  isJsonObject,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";

import {
  bytesEqual,
  callbackDigest,
  concatBytes,
  decodeUtf8,
  parseJsonValue,
  utf8,
} from "../bytes.js";
import type {
  CallbackRequest,
  CallbackVerification,
  ChannelAdapter,
  ClockLike,
  DeliveryDestination,
  DeliveryOutcome,
  FetchLike,
  RenderInput,
  RenderedMessage,
} from "../contract.js";
import { MAX_CALLBACK_BODY_BYTES, refuse } from "../contract.js";
import {
  classifyHttpStatus,
  classifyThrown,
  deliveryAbortSignal,
  httpOutcome,
} from "../http.js";
import { renderNotification } from "../templates.js";

export const SLACK_PROVIDER_ID = "slack";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_SIGNATURE_VERSION = "v0";

/**
 * Slack's documented replay window. Five minutes is generous for a click and
 * short enough that a signature captured from a proxy log is worthless by
 * the time anyone reads it.
 */
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Our own `action_id`s. The decision is carried here, never in `value`. */
export const SLACK_APPROVE_ACTION_ID = "opensesame_approve";
export const SLACK_DENY_ACTION_ID = "opensesame_deny";

export interface SlackConfig {
  /** Bot token. Sent in an Authorization header, never in a URL. */
  botToken: string;
  /** Shared with Slack only. The whole basis of callback provenance. */
  signingSecret: string;
  fetchImpl?: FetchLike;
  now?: ClockLike;
  apiBaseUrl?: string;
  timestampToleranceSeconds?: number;
}

const DEFAULT_API_BASE = "https://slack.com/api";

/**
 * Slack error names we will retry.
 *
 * An allowlist rather than a passthrough: `response.error` is a field a
 * provider fills, it ends up in a delivery row, and delivery rows are read
 * by operators and shipped to log sinks. Anything not on this list is
 * recorded as a fixed token so no provider-chosen text travels with it.
 */
const RETRYABLE_SLACK_ERRORS = new Set([
  "ratelimited",
  "rate_limited",
  "service_unavailable",
  "internal_error",
  "fatal_error",
  "request_timeout",
]);

/** Names we are willing to record verbatim, because we chose the vocabulary. */
const REPORTABLE_SLACK_ERRORS = new Set([
  ...RETRYABLE_SLACK_ERRORS,
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "channel_not_found",
  "user_not_found",
  "is_archived",
  "msg_too_long",
  "no_permission",
  "missing_scope",
  "restricted_action",
]);

export function createSlackAdapter(config: SlackConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const now: ClockLike = config.now ?? (() => new Date());
  const base = config.apiBaseUrl ?? DEFAULT_API_BASE;
  const tolerance =
    config.timestampToleranceSeconds ?? SLACK_TIMESTAMP_TOLERANCE_SECONDS;

  /**
   * Configured *to deliver*. Sending needs a bot token; checking an inbound
   * signature does not.
   */
  const isConfigured = (): boolean =>
    config.botToken.length > 0 && config.signingSecret.length > 0;

  /**
   * Configured *to verify*, which is a different question and deliberately a
   * weaker requirement.
   *
   * A deployment that lets people approve from Slack but sends its
   * notifications some other way holds a signing secret and no bot token.
   * Gating verification on the delivery credential would make that deployment
   * silently reject every genuine callback as "unconfigured" — a refusal that
   * looks exactly like a forged signature in the logs, which is the worst
   * possible way to be wrong.
   */
  const canVerify = (): boolean => config.signingSecret.length > 0;

  const capabilities = (): ChannelCapabilities => channelCapabilities("slack");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "slack_mrkdwn",
      channelCeiling: capabilities().confidentiality,
    });

  const post = async (
    method: string,
    payload: JsonObject,
  ): Promise<DeliveryOutcome> => {
    if (!isConfigured()) return { status: "unconfigured", error: "no_token" };
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: {
          // The token rides in a header. A bot token in a query string is a
          // bot token in every proxy log and referrer between here and Slack.
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: deliveryAbortSignal(),
      });
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
    if (classifyHttpStatus(response.status) !== "delivered") {
      return httpOutcome(response.status);
    }
    // Slack answers 200 for application-level failures too, so the HTTP
    // status alone is never the delivery verdict.
    const text = await response.text().catch(() => "");
    const body = readJsonObject(parseJsonValue(text));
    if (!body) return { status: "permanent", error: "provider_error" };
    if (body.ok === true) {
      const ref = messageRef(body);
      return ref
        ? { status: "delivered", providerMessageRef: ref }
        : { status: "delivered" };
    }
    const name = readString(body.error) ?? "";
    const reported = REPORTABLE_SLACK_ERRORS.has(name)
      ? name
      : "provider_error";
    return {
      status: RETRYABLE_SLACK_ERRORS.has(name) ? "retryable" : "permanent",
      error: reported,
    };
  };

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "slack") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    return post("chat.postMessage", {
      channel: dest.userId,
      text: msg.body,
      blocks: buildBlocks(msg),
    });
  };

  const update = async (
    ref: string,
    msg: RenderedMessage,
  ): Promise<DeliveryOutcome> => {
    const [channel, ts] = splitMessageRef(ref);
    if (!channel || !ts) {
      return { status: "permanent", error: "bad_message_ref" };
    }
    // Withdrawing the buttons is the point: an approval prompt that stays
    // clickable after the request is settled is a second decision waiting to
    // be made about something that is no longer pending.
    return post("chat.update", {
      channel,
      ts,
      text: msg.body,
      blocks: buildBlocks(withoutDecisionTokens(msg)),
    });
  };

  const verifyCallback = (raw: CallbackRequest): CallbackVerification => {
    if (!canVerify()) return refuse("unconfigured");
    if (raw.rawBody.length > MAX_CALLBACK_BODY_BYTES) {
      return refuse("body_too_large");
    }
    const signature = raw.headers[SLACK_SIGNATURE_HEADER];
    const timestamp = raw.headers[SLACK_TIMESTAMP_HEADER];
    if (!signature) return refuse("missing_signature");
    if (!timestamp) return refuse("timestamp_missing");
    if (!/^-?\d{1,15}$/u.test(timestamp)) return refuse("timestamp_malformed");

    const seconds = Number(timestamp);
    const nowSeconds = Math.floor((raw.now ?? now()).getTime() / 1000);
    const skew = nowSeconds - seconds;
    // Both directions. A far-future timestamp is not a clock problem worth
    // tolerating: it is how a captured signature is kept valid indefinitely.
    if (skew > tolerance) return refuse("timestamp_stale");
    if (-skew > tolerance) return refuse("timestamp_future");

    // The signed string is built over the raw bytes, not over a decoded and
    // re-encoded copy. UTF-8 round-tripping replaces invalid sequences with
    // U+FFFD, and a body that changed under us is a body Slack did not sign.
    const expected = createHmac("sha256", config.signingSecret)
      .update(
        concatBytes([
          utf8(`${SLACK_SIGNATURE_VERSION}:${timestamp}:`),
          raw.rawBody,
        ]),
      )
      .digest("hex");
    const presented = signature.startsWith(`${SLACK_SIGNATURE_VERSION}=`)
      ? signature.slice(SLACK_SIGNATURE_VERSION.length + 1)
      : undefined;
    if (!presented || !/^[0-9a-f]*$/u.test(presented)) {
      return refuse("malformed_signature");
    }
    if (
      !bytesEqual(Buffer.from(presented, "hex"), Buffer.from(expected, "hex"))
    ) {
      return refuse("signature_mismatch");
    }

    // Only now. Everything above ran on bytes and header text; the parser
    // gets to see the payload only after Slack has vouched for it, so a
    // parser bug is not reachable by an unauthenticated caller.
    const payload = parseInteractionPayload(raw.rawBody);
    if (!payload) return refuse("body_unparseable");

    const team = readJsonObject(payload.team);
    const user = readJsonObject(payload.user);
    const teamId = readString(team?.id) ?? "";
    const userId = readString(user?.id) ?? "";
    if (teamId.length === 0 || userId.length === 0) {
      return refuse("identity_missing");
    }

    const digest = callbackDigest("opensesame:slack-callback", [
      raw.rawBody,
      utf8(signature),
    ]);
    const action = firstOpenSesameAction(payload);
    const verified: CallbackVerification = {
      ok: true,
      providerId: SLACK_PROVIDER_ID,
      providerTenantId: teamId,
      providerSubjectId: userId,
      callbackDigest: digest,
      // Slack stamped the request and it fell inside the window, so this
      // callback carries provider-attested freshness of its own.
      fresh: true,
    };
    if (!action) return verified;
    const withDecision = action.decision
      ? { ...verified, decision: action.decision }
      : verified;
    return action.token
      ? { ...withDecision, opaqueRef: action.token }
      : withDecision;
  };

  return {
    kind: "slack",
    isConfigured,
    capabilities,
    render,
    deliver,
    verifyCallback,
    update,
  };
}

/* ------------------------------------------------------------------ *
 * Payload shapes
 * ------------------------------------------------------------------ */

/**
 * Interactive components arrive form-encoded as `payload=<json>`, while the
 * Events API posts JSON directly. Both are handled, and the form decoding
 * happens after the MAC — the signature covers the form bytes, so decoding
 * first would mean verifying something other than what Slack signed.
 */
function parseInteractionPayload(rawBody: Uint8Array): JsonObject | undefined {
  const text = decodeUtf8(rawBody);
  const direct = readJsonObject(parseJsonValue(text));
  if (direct) return direct;
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(text);
  } catch {
    return undefined;
  }
  const encoded = form.get("payload");
  if (!encoded) return undefined;
  return readJsonObject(parseJsonValue(encoded));
}

interface SlackAction {
  decision?: "approved" | "denied";
  token?: string;
}

/**
 * The decision comes from `action_id`, which we chose and Slack echoes; the
 * `value` is the one-time token the caller minted and must resolve. Reading
 * the decision from an attacker-influenceable field would let a stale button
 * in an old message name a verb for a new request.
 */
function firstOpenSesameAction(payload: JsonObject): SlackAction | undefined {
  const actions = payload.actions;
  if (!Array.isArray(actions)) return undefined;
  for (const entry of actions) {
    if (!isJsonObject(entry)) continue;
    const actionId = readString(entry.action_id);
    const token = readString(entry.value);
    if (actionId === SLACK_APPROVE_ACTION_ID) {
      return token ? { decision: "approved", token } : { decision: "approved" };
    }
    if (actionId === SLACK_DENY_ACTION_ID) {
      return token ? { decision: "denied", token } : { decision: "denied" };
    }
  }
  return undefined;
}

function messageRef(body: JsonObject): string | undefined {
  const channel = readString(body.channel);
  const ts = readString(body.ts);
  return channel && ts ? `${channel}:${ts}` : undefined;
}

/** Rebuild without the tokens rather than assigning `undefined` over them. */
function withoutDecisionTokens(msg: RenderedMessage): RenderedMessage {
  const { decisionTokens: _withdrawn, ...rest } = msg;
  return rest;
}

function splitMessageRef(
  ref: string,
): [string | undefined, string | undefined] {
  const separator = ref.indexOf(":");
  if (separator <= 0) return [undefined, undefined];
  return [ref.slice(0, separator), ref.slice(separator + 1)];
}

/**
 * Block Kit for the message.
 *
 * The link block is always there; the buttons appear only when the caller
 * minted decision tokens, which is how a `rendezvous`-mode step renders as a
 * link and an `interactive` one renders as a decision without the adapter
 * needing to be told which mode it is in.
 */
function buildBlocks(msg: RenderedMessage): JsonObject[] {
  const blocks: JsonObject[] = [
    { type: "section", text: { type: "mrkdwn", text: msg.body } },
  ];
  const elements: JsonObject[] = [];
  if (msg.rendezvousUrl) {
    elements.push({
      type: "button",
      action_id: "opensesame_open",
      text: { type: "plain_text", text: "Review in OpenSesame" },
      url: msg.rendezvousUrl,
    });
  }
  if (msg.decisionTokens) {
    elements.push({
      type: "button",
      action_id: SLACK_APPROVE_ACTION_ID,
      style: "primary",
      text: { type: "plain_text", text: "Approve" },
      value: msg.decisionTokens.approve,
    });
    elements.push({
      type: "button",
      action_id: SLACK_DENY_ACTION_ID,
      style: "danger",
      text: { type: "plain_text", text: "Deny" },
      value: msg.decisionTokens.deny,
    });
  }
  if (elements.length > 0) blocks.push({ type: "actions", elements });
  return blocks;
}
