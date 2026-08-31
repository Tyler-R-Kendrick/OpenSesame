import type { JsonObject } from "@opensesame/os-domain";
import {
  type WebhookSignature,
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
} from "@opensesame/webhooks";
import { describe, expect, it } from "vitest";

import {
  createGenericWebhookAdapter,
  webhookEventBody,
} from "../adapters/generic-webhook.js";
import { FIXED_NOW, jsonFetch, renderInput, throwingFetch } from "./helpers.js";

const ENDPOINT_URL = "https://receiver.example/hooks/inbox";
const SECRET = generateWebhookSecret();
const DELIVERY_ID = "whd_5f0f2a3c-1111-4444-8888-abcdefabcdef";

const EVENT_TYPE = "authority.invocation.requested";
const EVENT_PAYLOAD: JsonObject = {
  authReqId: "areq_01J8",
  requestDigest: "v2:9f86d081884c7d659a2feaa0c55ad015",
  occurredAt: "2026-08-31T12:00:00.000Z",
};

function adapter(fetchImpl: ReturnType<typeof jsonFetch>) {
  return createGenericWebhookAdapter({
    fetchImpl: fetchImpl.impl,
    now: () => FIXED_NOW,
  });
}

function message() {
  return adapter(jsonFetch("")).render(
    renderInput({
      kind: "webhook",
      eventType: EVENT_TYPE,
      eventPayload: EVENT_PAYLOAD,
    }),
  );
}

describe("generic webhook stays byte-identical to the worker dispatcher", () => {
  /**
   * `apps/worker/src/webhooks.ts` builds the body as
   * `JSON.stringify({ eventType, ...payload })` and signs that exact string.
   * Reproduced here rather than referenced, so a change on either side shows
   * up as a failing comparison instead of as a receiver whose signature
   * check quietly starts failing in production.
   */
  it("builds the same body the worker builds", () => {
    const workerBody = JSON.stringify({
      eventType: EVENT_TYPE,
      ...EVENT_PAYLOAD,
    });
    expect(webhookEventBody(EVENT_TYPE, EVENT_PAYLOAD)).toBe(workerBody);
    expect(message().body).toBe(workerBody);
  });

  it("sends the same bytes and the same signature headers", async () => {
    const recorder = jsonFetch("", 200);
    const hook = adapter(recorder);
    const outcome = await hook.deliver(message(), {
      channel: "webhook",
      endpointId: "whep_1",
      url: ENDPOINT_URL,
      secret: SECRET,
      deliveryId: DELIVERY_ID,
    });
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageRef: DELIVERY_ID,
    });

    const workerBody = JSON.stringify({
      eventType: EVENT_TYPE,
      ...EVENT_PAYLOAD,
    });
    const workerHeaders = signWebhook(
      SECRET,
      DELIVERY_ID,
      FIXED_NOW.getTime() / 1000,
      workerBody,
    );
    const call = recorder.calls[0];
    expect(call?.url).toBe(ENDPOINT_URL);
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe(workerBody);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["webhook-id"]).toBe(workerHeaders["webhook-id"]);
    expect(call?.headers["webhook-timestamp"]).toBe(
      workerHeaders["webhook-timestamp"],
    );
    expect(call?.headers["webhook-signature"]).toBe(
      workerHeaders["webhook-signature"],
    );
  });

  it("verifies under any Standard Webhooks verifier", async () => {
    const recorder = jsonFetch("", 200);
    const hook = adapter(recorder);
    await hook.deliver(message(), {
      channel: "webhook",
      endpointId: "whep_1",
      url: ENDPOINT_URL,
      secret: SECRET,
      deliveryId: DELIVERY_ID,
    });
    const call = recorder.calls[0];
    const headers: WebhookSignature = {
      "webhook-id": call?.headers["webhook-id"] ?? "",
      "webhook-timestamp": call?.headers["webhook-timestamp"] ?? "",
      "webhook-signature": call?.headers["webhook-signature"] ?? "",
    };
    expect(
      verifyWebhook(
        SECRET,
        headers,
        call?.body ?? "",
        Math.floor(FIXED_NOW.getTime() / 1000),
      ),
    ).toBe(true);
  });
});

describe("generic webhook is notify-only", () => {
  it("declares that it binds no external identity", () => {
    const hook = adapter(jsonFetch(""));
    expect(hook.capabilities().bindsExternalIdentity).toBe(false);
    expect(hook.capabilities().canRendezvous).toBe(false);
    expect(hook.capabilities().maximumInteractionMode).toBe("notify");
  });

  it("exposes neither a callback verifier nor an update", () => {
    const hook = adapter(jsonFetch(""));
    expect(hook.verifyCallback).toBeUndefined();
    expect(hook.update).toBeUndefined();
  });

  it("refuses a secret that would make the signer throw", async () => {
    const recorder = jsonFetch("");
    const hook = adapter(recorder);
    const outcome = await hook.deliver(message(), {
      channel: "webhook",
      endpointId: "whep_1",
      url: ENDPOINT_URL,
      secret: "plain-secret",
      deliveryId: DELIVERY_ID,
    });
    expect(outcome).toEqual({ status: "unconfigured", error: "bad_secret" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("refuses a cleartext endpoint unless the operator opted in", async () => {
    const recorder = jsonFetch("");
    const strict = adapter(recorder);
    await expect(
      strict.deliver(message(), {
        channel: "webhook",
        endpointId: "whep_1",
        url: "http://receiver.example/hooks/inbox",
        secret: SECRET,
        deliveryId: DELIVERY_ID,
      }),
    ).resolves.toEqual({ status: "permanent", error: "insecure_endpoint" });
    expect(recorder.calls).toHaveLength(0);

    const lenient = createGenericWebhookAdapter({
      fetchImpl: recorder.impl,
      now: () => FIXED_NOW,
      allowInsecureEndpoints: true,
    });
    await expect(
      lenient.deliver(message(), {
        channel: "webhook",
        endpointId: "whep_1",
        url: "http://127.0.0.1:9999/hooks",
        secret: SECRET,
        deliveryId: DELIVERY_ID,
      }),
    ).resolves.toEqual({
      status: "delivered",
      providerMessageRef: DELIVERY_ID,
    });
  });

  it("classifies a 502 as retryable and a 403 as permanent", async () => {
    const flaky = adapter(jsonFetch("", 502));
    await expect(
      flaky.deliver(message(), {
        channel: "webhook",
        endpointId: "whep_1",
        url: ENDPOINT_URL,
        secret: SECRET,
        deliveryId: DELIVERY_ID,
      }),
    ).resolves.toEqual({ status: "retryable", error: "status:502" });

    const denied = adapter(jsonFetch("", 403));
    await expect(
      denied.deliver(message(), {
        channel: "webhook",
        endpointId: "whep_1",
        url: ENDPOINT_URL,
        secret: SECRET,
        deliveryId: DELIVERY_ID,
      }),
    ).resolves.toEqual({ status: "permanent", error: "status:403" });
  });

  it("never carries a hostile receiver's response into the outcome", async () => {
    const hook = createGenericWebhookAdapter({
      fetchImpl: throwingFetch().impl,
      now: () => FIXED_NOW,
    });
    const outcome = await hook.deliver(message(), {
      channel: "webhook",
      endpointId: "whep_1",
      url: ENDPOINT_URL,
      secret: SECRET,
      deliveryId: DELIVERY_ID,
    });
    expect(outcome).toEqual({
      status: "retryable",
      error: "transport:TypeError",
    });
  });
});
