/**
 * Telegram — interactive, on a much thinner provenance story than Slack's.
 *
 * The Bot API has no request signature. What it has is `secret_token`: a
 * value the bot chooses when it registers its webhook, which Telegram then
 * echoes in `X-Telegram-Bot-Api-Secret-Token` on every update. That is a
 * bearer secret, not a MAC over the body, so it proves the *connection* came
 * from Telegram and proves nothing about the bytes. Two consequences shape
 * this adapter:
 *
 * - The comparison is constant-time, because a bearer secret compared with
 *   `===` leaks its prefix to anyone willing to send a few thousand updates
 *   and time the replies.
 * - `fresh` is reported as `false`. Telegram stamps no time on a callback
 *   query that we can trust as the moment of the click, so this adapter
 *   cannot establish freshness and says so rather than implying it. The
 *   caller gets freshness from the one-time token's own expiry.
 *
 * `callback_data` is an opaque, single-use token minted by the caller. Never
 * the authorization request id: `callback_data` is stored by Telegram, sits
 * in chat backups, and is guessable across requests if it is derived from
 * anything the requester can see. Because it is opaque, this adapter cannot
 * tell approve from deny — it returns the token and the caller resolves it,
 * which is the correct division: the meaning of a one-time token lives with
 * whoever minted it.
 */

import {
  type ChannelCapabilities,
  type JsonObject,
  type JsonValue,
  channelCapabilities,
  isNumber,
  readJsonObject,
  readString,
} from "@opensesame/os-domain";

import {
  callbackDigest,
  decodeUtf8,
  parseJsonValue,
  secretsEqual,
  utf8,
} from "../bytes.js";
import type {
  CallbackRequest,
  CallbackVerification,
  ChannelAdapter,
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

export const TELEGRAM_PROVIDER_ID = "telegram";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Telegram's own limit on `callback_data`. A token that does not fit is not
 * truncated — a truncated one-time token is a token that no longer resolves,
 * or worse, one that collides with another. The message degrades to a link
 * instead, which fails closed: the person still gets to the ceremony.
 */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export interface TelegramConfig {
  botToken: string;
  /** The `secret_token` registered with `setWebhook`. */
  callbackSecretToken: string;
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

/** Bot API error codes worth another attempt. */
const RETRYABLE_TELEGRAM_CODES = new Set([420, 429, 500, 502, 503, 504]);

export function createTelegramAdapter(config: TelegramConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const base = config.apiBaseUrl ?? DEFAULT_API_BASE;

  /** Configured *to deliver*: sending needs the bot token. */
  const isConfigured = (): boolean =>
    config.botToken.length > 0 && config.callbackSecretToken.length > 0;

  /**
   * Configured *to verify*, which needs only the secret token registered with
   * `setWebhook`. Same reasoning as Slack: a deployment that accepts Telegram
   * approvals but notifies elsewhere would otherwise reject every genuine
   * update as unconfigured, indistinguishably from a forgery.
   */
  const canVerify = (): boolean => config.callbackSecretToken.length > 0;

  const capabilities = (): ChannelCapabilities =>
    channelCapabilities("telegram");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "telegram_html",
      channelCeiling: capabilities().confidentiality,
    });

  const call = async (
    method: string,
    payload: JsonObject,
  ): Promise<DeliveryOutcome> => {
    if (!isConfigured()) return { status: "unconfigured", error: "no_token" };
    let response: Response;
    try {
      // The bot token is a path segment because the Bot API has no other
      // way to carry it. It is never logged, and `error` below never echoes
      // provider text that could contain it.
      response = await fetchImpl(`${base}/bot${config.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: deliveryAbortSignal(),
      });
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
    const text = await response.text().catch(() => "");
    const body = readJsonObject(parseJsonValue(text));
    if (classifyHttpStatus(response.status) !== "delivered") {
      const code = body
        ? numberOr(body.error_code, response.status)
        : response.status;
      return {
        status: RETRYABLE_TELEGRAM_CODES.has(code) ? "retryable" : "permanent",
        error: `status:${code}`,
      };
    }
    if (!body || body.ok !== true) {
      return { status: "permanent", error: "provider_error" };
    }
    const result = readJsonObject(body.result);
    const ref = messageRef(result);
    return ref
      ? { status: "delivered", providerMessageRef: ref }
      : { status: "delivered" };
  };

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "telegram") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    const payload: JsonObject = {
      chat_id: dest.chatId,
      text: msg.body,
      parse_mode: "HTML",
      // A link preview would fetch the rendezvous URL from Telegram's
      // infrastructure and render whatever came back into the chat.
      link_preview_options: { is_disabled: true },
    };
    const keyboard = buildKeyboard(msg);
    return call(
      "sendMessage",
      keyboard.length > 0
        ? { ...payload, reply_markup: { inline_keyboard: keyboard } }
        : payload,
    );
  };

  const update = async (
    ref: string,
    msg: RenderedMessage,
  ): Promise<DeliveryOutcome> => {
    const [chatId, messageId] = splitMessageRef(ref);
    if (!chatId || !messageId) {
      return { status: "permanent", error: "bad_message_ref" };
    }
    // Editing without a keyboard withdraws the buttons: a settled request
    // must stop offering a second decision.
    return call("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: msg.body,
      parse_mode: "HTML",
    });
  };

  const verifyCallback = (raw: CallbackRequest): CallbackVerification => {
    if (!canVerify()) return refuse("unconfigured");
    if (raw.rawBody.length > MAX_CALLBACK_BODY_BYTES) {
      return refuse("body_too_large");
    }
    const presented = raw.headers[TELEGRAM_SECRET_HEADER];
    // A missing header is refused rather than compared against "": an empty
    // string that happens to equal an empty configured secret is exactly the
    // hole that turns a misconfiguration into an open webhook.
    if (!presented) return refuse("missing_signature");
    if (!secretsEqual(presented, config.callbackSecretToken)) {
      return refuse("signature_mismatch");
    }

    const payload = readJsonObject(parseJsonValue(decodeUtf8(raw.rawBody)));
    if (!payload) return refuse("body_unparseable");
    const updateId = payload.update_id;
    if (!isNumber(updateId)) return refuse("body_unparseable");

    const query = readJsonObject(payload.callback_query);
    const message = readJsonObject(payload.message);
    const from = readJsonObject(query?.from) ?? readJsonObject(message?.from);
    const subjectId = from ? numericId(from.id) : undefined;
    // The numeric id, never `from.username`: a @username is released back
    // into the pool when it is changed, and the next holder inherits every
    // binding that resolved people by handle.
    if (!subjectId) return refuse("identity_missing");

    const digest = callbackDigest("opensesame:telegram-callback", [
      utf8(String(updateId)),
      raw.rawBody,
    ]);
    const verified: CallbackVerification = {
      ok: true,
      providerId: TELEGRAM_PROVIDER_ID,
      // Bot API updates name no workspace. The empty string is the honest
      // value and matches what the binding row stores for this channel.
      providerTenantId: "",
      providerSubjectId: subjectId,
      callbackDigest: digest,
      fresh: false,
    };
    const token = readString(query?.data);
    return token ? { ...verified, opaqueRef: token } : verified;
  };

  return {
    kind: "telegram",
    isConfigured,
    capabilities,
    render,
    deliver,
    verifyCallback,
    update,
  };
}

function buildKeyboard(msg: RenderedMessage): JsonObject[][] {
  const rows: JsonObject[][] = [];
  if (msg.rendezvousUrl) {
    rows.push([{ text: "Review in OpenSesame", url: msg.rendezvousUrl }]);
  }
  const tokens = msg.decisionTokens;
  if (
    tokens &&
    fitsCallbackData(tokens.approve) &&
    fitsCallbackData(tokens.deny)
  ) {
    rows.push([
      { text: "Approve", callback_data: tokens.approve },
      { text: "Deny", callback_data: tokens.deny },
    ]);
  }
  return rows;
}

function fitsCallbackData(token: string): boolean {
  return (
    token.length > 0 &&
    Buffer.byteLength(token, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
  );
}

/**
 * Telegram user ids are JSON numbers and can exceed 2^32; they are rendered
 * back to a decimal string so the binding tuple compares as text and never
 * loses a digit to float formatting.
 */
function numericId(value: JsonValue | undefined): string | undefined {
  if (!isNumber(value) || !Number.isSafeInteger(value)) return undefined;
  return String(value);
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return isNumber(value) ? value : fallback;
}

function messageRef(result: JsonObject | undefined): string | undefined {
  if (!result) return undefined;
  const chat = readJsonObject(result.chat);
  const chatId = chat ? numericId(chat.id) : undefined;
  const messageId = numericId(result.message_id);
  return chatId && messageId ? `${chatId}:${messageId}` : undefined;
}

function splitMessageRef(
  ref: string,
): [string | undefined, string | undefined] {
  const separator = ref.lastIndexOf(":");
  if (separator <= 0) return [undefined, undefined];
  return [ref.slice(0, separator), ref.slice(separator + 1)];
}
