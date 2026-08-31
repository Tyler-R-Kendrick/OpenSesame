/**
 * WeChat Official Account — provenance without a decision.
 *
 * The callback signature is real and checkable offline: WeChat sorts the
 * three values `token`, `timestamp`, `nonce` as strings, concatenates them,
 * takes SHA-1, and puts the hex in the `signature` query parameter. That is
 * enough to know a request came from WeChat, and it is what the echo
 * handshake and inbound messages are both verified with here.
 *
 * It is not enough to settle an authorization, and the reason is not the
 * signature — it is that an interactive approval would need a verified
 * service account plus a per-user OpenID obtained through an authorization
 * flow this repository cannot exercise. The os-domain catalogue therefore
 * sets `canRenderDecisionActions: false` for this channel, and this adapter
 * matches it exactly: `verifyCallback` returns identity and provenance and
 * **never** a `decision` field. A verified-but-meaningless "yes" is worse
 * than no callback at all, because it looks like evidence.
 *
 * Note also what the signature does *not* cover: the body. WeChat's scheme
 * signs three query parameters and nothing else, so a signature proves the
 * request came from WeChat while the XML it carries is unauthenticated in
 * itself. That is another reason the ceiling stops at `rendezvous` — the
 * body is used to find out who to point at the ceremony, not to decide.
 */

import { createHash } from "node:crypto";

import {
  type ChannelCapabilities,
  channelCapabilities,
} from "@opensesame/os-domain";

import { callbackDigest, decodeUtf8, secretsEqual, utf8 } from "../bytes.js";
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

export const WECHAT_PROVIDER_ID = "wechat";

/** Same window as everywhere else here; the timestamp is inside the digest. */
export const WECHAT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface WeChatConfig {
  /** The Official Account app id. Doubles as the binding's tenant. */
  appId: string;
  /** The token configured in the Official Account console. */
  token: string;
  /**
   * Supplies a current `access_token`. Injected rather than stored because
   * it expires every two hours and is refreshed by whoever owns the
   * credential, not by a notification adapter.
   */
  accessToken?: () => Promise<string>;
  fetchImpl?: FetchLike;
  now?: ClockLike;
  apiBaseUrl?: string;
}

const DEFAULT_API_BASE = "https://api.weixin.qq.com";

export function createWeChatAdapter(config: WeChatConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const now: ClockLike = config.now ?? (() => new Date());
  const base = config.apiBaseUrl ?? DEFAULT_API_BASE;

  const isConfigured = (): boolean =>
    config.appId.length > 0 && config.token.length > 0;

  const capabilities = (): ChannelCapabilities => channelCapabilities("wechat");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "xml_text",
      channelCeiling: capabilities().confidentiality,
    });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "wechat") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    if (!isConfigured() || !config.accessToken) {
      return { status: "unconfigured", error: "no_access_token" };
    }
    let token: string;
    try {
      token = await config.accessToken();
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
    if (token.length === 0) {
      return { status: "unconfigured", error: "no_access_token" };
    }
    const text = msg.rendezvousUrl
      ? `${msg.title}\n${msg.body}\n${msg.rendezvousUrl}`
      : `${msg.title}\n${msg.body}`;
    try {
      // WeChat's custom-send API takes the access token as a query
      // parameter; there is no header form. It is therefore never logged and
      // never included in a delivery error, and the URL is built here rather
      // than passed in so no caller can redirect it somewhere that would see
      // the token.
      const response = await fetchImpl(
        `${base}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            touser: dest.openId,
            msgtype: "text",
            text: { content: text },
          }),
          signal: deliveryAbortSignal(),
        },
      );
      if (classifyHttpStatus(response.status) !== "delivered") {
        return httpOutcome(response.status);
      }
      return { status: "delivered" };
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
  };

  const verifyCallback = (raw: CallbackRequest): CallbackVerification => {
    if (!isConfigured()) return refuse("unconfigured");
    if (raw.rawBody.length > MAX_CALLBACK_BODY_BYTES) {
      return refuse("body_too_large");
    }
    const query = raw.query ?? {};
    const signature = query.signature;
    const timestamp = query.timestamp;
    const nonce = query.nonce;
    if (!signature) return refuse("missing_signature");
    if (!timestamp) return refuse("timestamp_missing");
    if (!nonce) return refuse("malformed_signature");
    if (!/^\d{1,15}$/u.test(timestamp)) return refuse("timestamp_malformed");

    const seconds = Number(timestamp);
    const nowSeconds = Math.floor((raw.now ?? now()).getTime() / 1000);
    const skew = nowSeconds - seconds;
    if (skew > WECHAT_TIMESTAMP_TOLERANCE_SECONDS)
      return refuse("timestamp_stale");
    if (-skew > WECHAT_TIMESTAMP_TOLERANCE_SECONDS)
      return refuse("timestamp_future");

    if (
      !secretsEqual(signature, wechatSignature(config.token, timestamp, nonce))
    ) {
      return refuse("signature_mismatch");
    }

    const digest = callbackDigest("opensesame:wechat-callback", [
      utf8(signature),
      utf8(nonce),
      raw.rawBody,
    ]);

    // The echo handshake carries no user at all. Returning it as verified
    // with an empty subject is deliberate and safe: the domain's
    // `bindingMatchesProviderIdentity` requires a non-empty subject, so an
    // empty one can never match a binding no matter who calls it.
    const echo = query.echostr;
    if (echo) {
      return {
        ok: true,
        providerId: WECHAT_PROVIDER_ID,
        providerTenantId: config.appId,
        providerSubjectId: "",
        callbackDigest: digest,
        opaqueRef: echo,
        fresh: true,
      };
    }

    const from = readXmlText(decodeUtf8(raw.rawBody), "FromUserName");
    if (!from) return refuse("identity_missing");
    // No `decision`, ever. The catalogue says this channel cannot render a
    // decision affordance, so there is nothing here that could have produced
    // one, and a field that is never set cannot be misread as evidence.
    return {
      ok: true,
      providerId: WECHAT_PROVIDER_ID,
      providerTenantId: config.appId,
      providerSubjectId: from,
      callbackDigest: digest,
      fresh: true,
    };
  };

  return {
    kind: "wechat",
    isConfigured,
    capabilities,
    render,
    deliver,
    verifyCallback,
  };
}

/**
 * The Official Account signature: sort the three values as strings, join
 * them with nothing between, SHA-1, hex.
 *
 * The sort is the part that is easy to get wrong and easy to leave untested.
 * It is a lexicographic sort of the *values*, not of any parameter names, so
 * a token beginning with a digit sorts before a timestamp and the order
 * changes with the data. Getting it wrong fails closed — every signature
 * mismatches — which is why a test pins the algorithm against a
 * hand-computed vector rather than against this function's own output.
 */
export function wechatSignature(
  token: string,
  timestamp: string,
  nonce: string,
): string {
  const joined = [token, timestamp, nonce].sort().join("");
  return createHash("sha1").update(utf8(joined)).digest("hex");
}

/**
 * Pull one element's text out of the callback XML.
 *
 * A deliberately tiny reader rather than an XML parser: this input is
 * attacker-reachable, and a real parser brings entity expansion and external
 * entity resolution — the whole XXE family — to a job that needs one string.
 * Non-greedy, bounded, and it never throws.
 */
export function readXmlText(xml: string, element: string): string | undefined {
  const pattern = new RegExp(
    `<${element}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]{0,256}?)(?:\\]\\]>)?\\s*</${element}>`,
    "u",
  );
  const match = pattern.exec(xml);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}
