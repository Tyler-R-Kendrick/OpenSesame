/**
 * The generic signed webhook — a compatibility surface, not a new one.
 *
 * Receivers already exist. `apps/worker/src/webhooks.ts` has been posting
 * `{"eventType": …, …payload}` under Standard Webhooks signatures since ADR
 * 0046 decision 12, and somebody has a verifier pointed at it. So this
 * adapter reproduces that request byte for byte — same body construction,
 * same `signWebhook` call, same header set — rather than inventing a
 * notification-shaped envelope that would quietly break every existing
 * receiver the moment notifications started flowing through adapters.
 *
 * It signs with `@opensesame/webhooks`, which is the point: the wire
 * convention is Standard Webhooks, so an operator verifies with any
 * off-the-shelf library instead of an OpenSesame-specific one.
 *
 * `bindsExternalIdentity` is `false` in the os-domain catalogue and that is
 * the whole character of this channel. An endpoint is a program. A correct
 * HMAC proves a shared secret was used; it says nothing about a person, and
 * there is no person on the other end of a webhook to say anything about.
 * Hence notify-only: no `verifyCallback`, no `update`, no decision.
 */

import {
  type ChannelCapabilities,
  type JsonObject,
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

export const WEBHOOK_PROVIDER_ID = "webhook";

export interface GenericWebhookConfig {
  fetchImpl?: FetchLike;
  now?: ClockLike;
  /**
   * Allow plain-HTTP endpoints. Off by default and intended only for a
   * loopback receiver in development: over the network, an unencrypted POST
   * hands the event to the path even though the signature stops it being
   * forged.
   */
  allowInsecureEndpoints?: boolean;
}

/**
 * The event body, rebuilt exactly as the worker builds it.
 *
 * Spread order included: `eventType` first, then the payload, so a payload
 * that carries its own `eventType` overrides it in both places or neither.
 * Reproducing a quirk is the job here — a receiver's signature check is over
 * these bytes, so "improving" the shape is a breaking change wearing a
 * cleanup's clothes.
 */
export function webhookEventBody(
  eventType: string,
  payload: JsonObject | undefined,
): string {
  return JSON.stringify({ eventType, ...(payload ?? {}) });
}

export function createGenericWebhookAdapter(
  config: GenericWebhookConfig = {},
): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const now: ClockLike = config.now ?? (() => new Date());

  // Nothing to configure: the secret and URL live on the endpoint row, so
  // the channel is available wherever an endpoint has been registered.
  const isConfigured = (): boolean => true;

  const capabilities = (): ChannelCapabilities =>
    channelCapabilities("webhook");

  const render = (input: RenderInput): RenderedMessage => {
    const message = renderNotification(input, {
      dialect: "plain",
      channelCeiling: capabilities().confidentiality,
    });
    // The wire body is the digest-shaped event, not the prose. The prose is
    // still rendered so the same `RenderedMessage` shape flows everywhere,
    // but `deliver` sends the event and a receiver sees what it always saw.
    return {
      ...message,
      body: webhookEventBody(input.eventType, input.eventPayload),
    };
  };

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "webhook") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    if (!dest.secret.startsWith(SECRET_PREFIX)) {
      // `signWebhook` throws on a secret without the prefix. Reporting it as
      // a misconfiguration keeps the delivery path free of exceptions that a
      // retry loop would treat as a transient failure forever.
      return { status: "unconfigured", error: "bad_secret" };
    }
    if (!isHttpsUrl(dest.url) && !config.allowInsecureEndpoints) {
      return { status: "permanent", error: "insecure_endpoint" };
    }
    const at = now();
    const headers = signWebhook(
      dest.secret,
      dest.deliveryId,
      at.getTime() / 1000,
      msg.body,
    );
    try {
      const response = await fetchImpl(dest.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: msg.body,
        signal: deliveryAbortSignal(),
      });
      const outcome = httpOutcome(response.status);
      return outcome.status === "delivered"
        ? { status: "delivered", providerMessageRef: dest.deliveryId }
        : outcome;
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
  };

  return { kind: "webhook", isConfigured, capabilities, render, deliver };
}
