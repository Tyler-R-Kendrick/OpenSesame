import {
  type ChannelAdapter,
  type DeliveryDestination,
  type DeliveryOutcome,
  type RenderInput,
  type RenderedMessage,
  createSmsAdapter,
} from "@opensesame/notification-adapters";
import {
  type BoundaryValue,
  channelCapabilities,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

/**
 * The deployment's text-message sender.
 *
 * Prefers Twilio when `OPENSESAME_TWILIO_*` is set (same provider Pages binds
 * under `mfa_sms`), then the operator-run SMS bridge
 * (`OPENSESAME_SMS_BRIDGE_URL` + `OPENSESAME_SMS_BRIDGE_SECRET`). Nothing here
 * invents a carrier credential: either Twilio's REST API or the bridge does.
 */

function createTwilioSms(env: NodeJS.ProcessEnv): ChannelAdapter | undefined {
  const accountSid = env.OPENSESAME_TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.OPENSESAME_TWILIO_AUTH_TOKEN?.trim();
  const fromNumber =
    env.OPENSESAME_TWILIO_FROM_NUMBER?.trim() ||
    env.OPENSESAME_TWILIO_PHONE_NUMBER?.trim();
  if (!accountSid || !authToken || !fromNumber) return undefined;

  const isConfigured = (): boolean => true;
  const capabilities = () => channelCapabilities("sms");

  const render = (input: RenderInput): RenderedMessage => ({
    kind: "sms",
    confidentiality: "minimal",
    title: input.actionLabel?.trim() || "OpenSesame",
    body: input.bindingMessage?.trim() || "A code is waiting.",
  });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "sms") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    const body = msg.body.trim();
    if (!body) {
      return { status: "permanent", error: "empty_body" };
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString(
      "base64",
    );
    const form = new URLSearchParams({
      To: dest.e164,
      From: fromNumber,
      Body: body,
    });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return {
          status: res.status >= 500 ? "retryable" : "permanent",
          error: `twilio_${res.status}`,
        };
      }
      const payload: BoundaryValue = await res.json().catch(() => null);
      const sid =
        isJsonObject(payload) && isString(payload.sid) ? payload.sid : "";
      return { status: "delivered", providerMessageRef: sid };
    } catch {
      return { status: "retryable", error: "twilio_unreachable" };
    }
  };

  return { kind: "sms", isConfigured, capabilities, render, deliver };
}

export function createSmsBridge(env: NodeJS.ProcessEnv): ChannelAdapter {
  const twilio = createTwilioSms(env);
  if (twilio) return twilio;

  const bridgeUrl = env.OPENSESAME_SMS_BRIDGE_URL?.trim();
  const bridgeSecret = env.OPENSESAME_SMS_BRIDGE_SECRET?.trim();
  const senderId = env.OPENSESAME_SMS_SENDER_ID?.trim();
  if (bridgeUrl && bridgeSecret && senderId) {
    return createSmsAdapter({ bridgeUrl, bridgeSecret, senderId });
  }
  if (bridgeUrl && bridgeSecret) {
    return createSmsAdapter({ bridgeUrl, bridgeSecret });
  }
  if (bridgeUrl) {
    return createSmsAdapter({ bridgeUrl });
  }
  if (bridgeSecret) {
    return createSmsAdapter({ bridgeSecret });
  }
  if (senderId) {
    return createSmsAdapter({ senderId });
  }
  return createSmsAdapter({});
}
