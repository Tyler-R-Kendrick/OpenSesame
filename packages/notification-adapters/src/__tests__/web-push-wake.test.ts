import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWebPushAdapter,
  decryptWebPushPayload,
  generateVapidKeyPair,
  pushSubscriptionRefusal,
} from "../adapters/web-push.js";
import type { WebPushConfig } from "../adapters/web-push.js";
import { base64UrlDecode, base64UrlEncode } from "../bytes.js";
import { jsonFetch, renderInput, subscribe, vapidConfig } from "./helpers.js";

/**
 * What goes on the wire (the service worker's closed vocabulary), what the
 * adapter will not send, and what a registration may hold. The encryption and
 * VAPID framing are in `web-push.test.ts`.
 */
describe("web push payload and configuration", () => {
  it("sends exactly the keys the service worker reads, for every class", async () => {
    const expected = {
      authorization_request: "review",
      authorization_decision: "decided",
      security_event: "none",
    } as const;
    for (const [notificationClass, action] of Object.entries(expected)) {
      const recorder = jsonFetch("", 201);
      const { subscription, uaPrivateKey, authSecret } = subscribe();
      const push = createWebPushAdapter(
        vapidConfig({ fetchImpl: recorder.impl }),
      );
      const message = push.render(
        renderInput({
          kind: "native_push",
          notificationClass: notificationClass as keyof typeof expected,
        }),
      );
      await push.deliver(message, { channel: "native_push", subscription });
      const payload = JSON.parse(
        decryptWebPushPayload(
          recorder.calls[0]?.bodyBytes ?? new Uint8Array(),
          uaPrivateKey,
          authSecret,
        ).toString("utf8"),
      );
      expect(Object.keys(payload).sort()).toEqual(["action", "kind", "ref"]);
      expect(payload).toEqual({
        kind: notificationClass,
        action,
        ref: "rz-QHXT-KPLM",
      });
    }
  });

  it("omits a reference the service worker would refuse to put in a URL", () => {
    const push = createWebPushAdapter(vapidConfig());
    for (const rendezvousRef of [
      "",
      "a/b",
      "https://x.test/y",
      "has space",
      "a".repeat(129),
    ]) {
      const message = push.render(
        renderInput({ kind: "native_push", rendezvousRef }),
      );
      expect(message.wake).toEqual({
        kind: "authorization_request",
        action: "review",
      });
    }
  });

  it("refuses a message it did not render, and a tampered one, without calling out", async () => {
    const recorder = jsonFetch("", 201);
    const { subscription } = subscribe();
    const push = createWebPushAdapter(
      vapidConfig({ fetchImpl: recorder.impl }),
    );
    const rendered = push.render(renderInput({ kind: "native_push" }));
    const { wake: _dropped, ...unrendered } = rendered;
    await expect(
      push.deliver(unrendered, { channel: "native_push", subscription }),
    ).resolves.toEqual({ status: "permanent", error: "not_a_wake_message" });
    await expect(
      push.deliver(
        { ...rendered, wake: { kind: "security_event", action: "review" } },
        { channel: "native_push", subscription },
      ),
    ).resolves.toEqual({ status: "permanent", error: "not_a_wake_message" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("is unconfigured when the private key is not the public key's, or the contact is not a contact", () => {
    const keys = generateVapidKeyPair();
    const stranger = generateVapidKeyPair();
    const configured = (extra: Partial<WebPushConfig>) =>
      createWebPushAdapter({
        vapidPublicKey: keys.publicKey,
        vapidPrivateKey: keys.privateKey,
        vapidSubject: "mailto:ops@example.test",
        ...extra,
      }).isConfigured();
    expect(configured({})).toBe(true);
    expect(configured({ vapidPrivateKey: stranger.privateKey })).toBe(false);
    expect(configured({ vapidSubject: "ops@example.test" })).toBe(false);
    expect(configured({ vapidSubject: "http://ops.example.test" })).toBe(false);
  });
});

describe("registration-time refusal", () => {
  it("accepts what a browser produces", () => {
    expect(pushSubscriptionRefusal(subscribe().subscription)).toBeUndefined();
  });

  it("applies the delivery fence to the endpoint, with the same names", () => {
    const { subscription } = subscribe();
    const at = (endpoint: string) =>
      pushSubscriptionRefusal({ ...subscription, endpoint });
    expect(at("http://push.example.test/x")).toBe("insecure_endpoint");
    expect(at("https://u:p@push.example.test/x")).toBe("insecure_endpoint");
    expect(at("https://127.0.0.1/x")).toBe("private_endpoint");
    expect(at("https://localhost/x")).toBe("private_endpoint");
    expect(at("https://192.168.1.5/x")).toBe("private_endpoint");
  });

  it("refuses keys RFC 8291 cannot encrypt to", () => {
    const { subscription } = subscribe();
    const keys = (p256dh: string, auth = subscription.keys.auth) => ({
      ...subscription,
      keys: { p256dh, auth },
    });
    const point = base64UrlDecode(subscription.keys.p256dh);
    expect(pushSubscriptionRefusal(keys("AAAA"))).toBe("invalid_keys");
    expect(
      pushSubscriptionRefusal(
        keys(
          base64UrlEncode(
            Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]),
          ),
        ),
      ),
    ).toBe("invalid_keys");
    expect(pushSubscriptionRefusal(keys(point.toString("base64")))).toBe(
      "invalid_keys",
    );
    expect(
      pushSubscriptionRefusal(
        keys(subscription.keys.p256dh, base64UrlEncode(randomBytes(15))),
      ),
    ).toBe("invalid_keys");
  });
});
