/**
 * SMS — through an operator-run bridge, never a vendor SDK.
 *
 * There is no commercial dependency here, and that is a design decision
 * rather than a licensing preference. Binding a notification path to one
 * carrier aggregator means the aggregator sees every approval prompt this
 * deployment ever sends, in plaintext, with timing; and it means the
 * deployment's SMS story is whatever that vendor's SDK does with its
 * credentials and its telemetry. So the contract is a POST the operator
 * terminates: they run the bridge, they hold the carrier credential, and
 * they decide what leaves their network.
 *
 * The POST is signed with Standard Webhooks — the same `@opensesame/webhooks`
 * signer the rest of the system uses — so the operator can verify it with
 * any off-the-shelf Standard Webhooks library instead of implementing
 * something OpenSesame-shaped.
 *
 * The body is `minimal` whatever the caller asks for, and the reason is in
 * the os-domain catalogue: a phone number is a lease from a carrier, and SIM
 * swap and number reassignment both transfer it without the holder doing
 * anything. Whoever holds the number today reads this message, so it says
 * only that something is waiting.
 */

import { randomUUID } from "node:crypto";

import {
  type ChannelCapabilities,
  channelCapabilities,
} from "@opensesame/os-domain";
import { SECRET_PREFIX, signWebhook } from "@opensesame/webhooks";

import type {
  ChannelAdapter,
  ClockLike,
  DeliveryDestination,
  DeliveryOutcome,
  FetchLike,
  RenderInput,
  RenderedMessage,
} from "../contract.js";
import {
  classifyThrown,
  deliveryAbortSignal,
  httpOutcome,
  isHttpsUrl,
} from "../http.js";
import { renderNotification } from "../templates.js";

export const SMS_PROVIDER_ID = "sms";
export const SMS_EVENT_TYPE = "notification.sms.requested";

/** Two GSM segments. Longer costs more and says nothing more. */
export const MAX_SMS_CHARS = 300;

export interface SmsConfig {
  /** HTTPS endpoint of the operator's own bridge. */
  bridgeUrl?: string;
  /** `whsec_`-prefixed Standard Webhooks secret shared with that bridge. */
  bridgeSecret?: string;
  /** Sender id or short code, passed through for the bridge to use. */
  senderId?: string;
  fetchImpl?: FetchLike;
  now?: ClockLike;
  /** Delivery id source; injected so a test can pin the signature inputs. */
  newDeliveryId?: () => string;
}

export function createSmsAdapter(config: SmsConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const now: ClockLike = config.now ?? (() => new Date());
  const newDeliveryId = config.newDeliveryId ?? (() => `smsd_${randomUUID()}`);

  /**
   * Both halves, and the secret's prefix. A bridge URL with no secret would
   * post approval prompts to an unauthenticated endpoint; a secret without
   * the `whsec_` prefix makes `signWebhook` throw at send time, which is a
   * misconfiguration better reported as "unconfigured" than as a crash on
   * the delivery path.
   */
  const isConfigured = (): boolean =>
    isHttpsUrl(config.bridgeUrl) &&
    (config.bridgeSecret?.startsWith(SECRET_PREFIX) ?? false);

  const capabilities = (): ChannelCapabilities => channelCapabilities("sms");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "plain",
      // `minimal` regardless of what the router asked for. The channel's own
      // catalogue ceiling is already `minimal`; passing it explicitly means
      // the reduction happens even if the catalogue is ever loosened.
      channelCeiling: "minimal",
    });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "sms") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    const url = config.bridgeUrl;
    const secret = config.bridgeSecret;
    // Checked before anything is built, and certainly before any fetch: an
    // unconfigured channel must be silent, not "try it and see".
    if (!isConfigured() || !url || !secret) {
      return { status: "unconfigured", error: "no_bridge" };
    }

    const text = smsText(msg);
    const deliveryId = newDeliveryId();
    const at = now();
    const body = JSON.stringify(
      config.senderId
        ? {
            eventType: SMS_EVENT_TYPE,
            to: dest.e164,
            text,
            senderId: config.senderId,
          }
        : { eventType: SMS_EVENT_TYPE, to: dest.e164, text },
    );
    const signature = signWebhook(
      secret,
      deliveryId,
      at.getTime() / 1000,
      body,
    );

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...signature },
        body,
        signal: deliveryAbortSignal(),
      });
      const outcome = httpOutcome(response.status);
      return outcome.status === "delivered"
        ? { status: "delivered", providerMessageRef: deliveryId }
        : outcome;
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
  };

  // No `verifyCallback` and no `update`. An inbound SMS is authenticated by
  // nothing but a caller id, which is forgeable, and a sent message cannot
  // be recalled.
  return { kind: "sms", isConfigured, capabilities, render, deliver };
}

function smsText(msg: RenderedMessage): string {
  const joined = msg.rendezvousUrl
    ? `${msg.body}\n${msg.rendezvousUrl}`
    : msg.body;
  return joined.length > MAX_SMS_CHARS
    ? `${joined.slice(0, MAX_SMS_CHARS - 1)}…`
    : joined;
}
