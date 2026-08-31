import { describe, expect, it } from "vitest";

import {
  type WebhookSignature,
  generateWebhookSecret,
  verifyWebhook,
} from "@opensesame/webhooks";

import { SMS_EVENT_TYPE, createSmsAdapter } from "../adapters/sms.js";
import { FIXED_NOW, jsonFetch, renderInput, throwingFetch } from "./helpers.js";

const BRIDGE_URL = "https://sms-bridge.internal.example/v1/send";
const BRIDGE_SECRET = generateWebhookSecret();

function bridge(recorderImpl: ReturnType<typeof jsonFetch>) {
  return createSmsAdapter({
    bridgeUrl: BRIDGE_URL,
    bridgeSecret: BRIDGE_SECRET,
    senderId: "OPENSESAME",
    fetchImpl: recorderImpl.impl,
    now: () => FIXED_NOW,
    newDeliveryId: () => "smsd_fixed_0001",
  });
}

describe("sms is unconfigured until the operator stands up a bridge", () => {
  it("reports unconfigured and attempts no request", async () => {
    const recorder = jsonFetch("{}");
    const sms = createSmsAdapter({ fetchImpl: recorder.impl });
    expect(sms.isConfigured()).toBe(false);
    const outcome = await sms.deliver(
      sms.render(renderInput({ kind: "sms" })),
      {
        channel: "sms",
        e164: "+15551234567",
      },
    );
    expect(outcome).toEqual({ status: "unconfigured", error: "no_bridge" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("stays unconfigured for a plain-HTTP bridge", () => {
    expect(
      createSmsAdapter({
        bridgeUrl: "http://sms-bridge.internal.example/v1/send",
        bridgeSecret: BRIDGE_SECRET,
      }).isConfigured(),
    ).toBe(false);
  });

  it("stays unconfigured for a secret without the whsec_ prefix", async () => {
    const recorder = jsonFetch("{}");
    const sms = createSmsAdapter({
      bridgeUrl: BRIDGE_URL,
      bridgeSecret: "not-a-standard-webhooks-secret",
      fetchImpl: recorder.impl,
    });
    expect(sms.isConfigured()).toBe(false);
    // `signWebhook` would throw on that secret; reporting it as
    // unconfigured keeps the exception off the delivery path entirely.
    await expect(
      sms.deliver(sms.render(renderInput({ kind: "sms" })), {
        channel: "sms",
        e164: "+15551234567",
      }),
    ).resolves.toEqual({ status: "unconfigured", error: "no_bridge" });
    expect(recorder.calls).toHaveLength(0);
  });
});

describe("sms bridge request", () => {
  it("signs with Standard Webhooks so any SW library can verify it", async () => {
    const recorder = jsonFetch("{}", 202);
    const sms = bridge(recorder);
    const outcome = await sms.deliver(
      sms.render(renderInput({ kind: "sms" })),
      { channel: "sms", e164: "+15551234567" },
    );
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageRef: "smsd_fixed_0001",
    });
    const call = recorder.calls[0];
    const headers: WebhookSignature = {
      "webhook-id": call?.headers["webhook-id"] ?? "",
      "webhook-timestamp": call?.headers["webhook-timestamp"] ?? "",
      "webhook-signature": call?.headers["webhook-signature"] ?? "",
    };
    expect(headers["webhook-id"]).toBe("smsd_fixed_0001");
    expect(
      verifyWebhook(
        BRIDGE_SECRET,
        headers,
        call?.body ?? "",
        Math.floor(FIXED_NOW.getTime() / 1000),
      ),
    ).toBe(true);
  });

  it("fails verification when a byte of the body is altered", async () => {
    const recorder = jsonFetch("{}", 202);
    const sms = bridge(recorder);
    await sms.deliver(sms.render(renderInput({ kind: "sms" })), {
      channel: "sms",
      e164: "+15551234567",
    });
    const call = recorder.calls[0];
    const headers: WebhookSignature = {
      "webhook-id": call?.headers["webhook-id"] ?? "",
      "webhook-timestamp": call?.headers["webhook-timestamp"] ?? "",
      "webhook-signature": call?.headers["webhook-signature"] ?? "",
    };
    expect(
      verifyWebhook(
        BRIDGE_SECRET,
        headers,
        `${call?.body ?? ""} `,
        Math.floor(FIXED_NOW.getTime() / 1000),
      ),
    ).toBe(false);
  });

  it("sends only a minimal body, whatever the caller asked for", async () => {
    const recorder = jsonFetch("{}", 202);
    const sms = bridge(recorder);
    await sms.deliver(
      sms.render(
        renderInput({
          kind: "sms",
          confidentiality: "full",
          requesterLabel: "agent-7",
        }),
      ),
      { channel: "sms", e164: "+15551234567" },
    );
    const body = recorder.calls[0]?.body ?? "";
    expect(body).toContain(SMS_EVENT_TYPE);
    expect(body).toContain("+15551234567");
    expect(body).toContain("rz-QHXT-KPLM");
    expect(body).not.toContain("Transfer funds");
    expect(body).not.toContain("agent-7");
  });

  it("carries no callback surface and nothing to revise", () => {
    const sms = bridge(jsonFetch("{}"));
    expect(sms.verifyCallback).toBeUndefined();
    expect(sms.update).toBeUndefined();
    expect(sms.capabilities().canReceiveAuthenticatedCallback).toBe(false);
  });

  it("treats a transport failure as retryable", async () => {
    const sms = createSmsAdapter({
      bridgeUrl: BRIDGE_URL,
      bridgeSecret: BRIDGE_SECRET,
      fetchImpl: throwingFetch().impl,
    });
    await expect(
      sms.deliver(sms.render(renderInput({ kind: "sms" })), {
        channel: "sms",
        e164: "+15551234567",
      }),
    ).resolves.toEqual({ status: "retryable", error: "transport:TypeError" });
  });
});
