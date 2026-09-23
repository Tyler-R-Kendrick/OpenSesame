import { createECDH, randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { Writable } from "node:stream";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTeamsAdapter } from "../adapters/teams.js";
import {
  createWebPushAdapter,
  generateVapidKeyPair,
} from "../adapters/web-push.js";
import { base64UrlEncode } from "../bytes.js";
import type { FetchLike, PushSubscriptionRecord } from "../contract.js";
import { endpointRefusal, postPublicOnly } from "../public-endpoint.js";
import { FIXED_NOW, renderInput } from "./helpers.js";

const transport = { request: vi.spyOn(https, "request") };

beforeEach(() => {
  transport.request.mockReset();
});
afterAll(() => {
  transport.request.mockRestore();
});

const PRIVATE_ENDPOINTS = [
  "https://127.0.0.1/push",
  "https://[::1]/push",
  "https://10.0.0.7/push",
  "https://169.254.169.254/latest/meta-data",
  "https://2130706433/push",
  "https://localhost/push",
  "https://metadata.google.internal/computeMetadata",
];
const INSECURE_ENDPOINTS = [
  "http://push.example.test/push",
  "ftp://push.example.test/push",
  "https://user:pass@push.example.test/push",
  "not a url",
];

/** A fetch that records its init and must not be reached for a refusal. */
function spyFetch(status = 201) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  };
  return { calls, impl };
}

function subscription(endpoint: string): PushSubscriptionRecord {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: base64UrlEncode(ua.getPublicKey()),
      auth: base64UrlEncode(randomBytes(16)),
    },
  };
}

function webPush(fetchImpl: FetchLike) {
  const keys = generateVapidKeyPair();
  return createWebPushAdapter({
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
    vapidSubject: "mailto:ops@example.test",
    now: () => FIXED_NOW,
    fetchImpl,
  });
}

describe("endpointRefusal", () => {
  it.each(PRIVATE_ENDPOINTS)("refuses %s as private", (url) => {
    expect(endpointRefusal(url)).toBe("private_endpoint");
  });

  it.each(INSECURE_ENDPOINTS)("refuses %s as insecure", (url) => {
    expect(endpointRefusal(url)).toBe("insecure_endpoint");
  });

  it("accepts a public HTTPS endpoint", () => {
    expect(endpointRefusal("https://fcm.googleapis.com/fcm/send/x")).toBe(
      undefined,
    );
    expect(endpointRefusal(undefined)).toBe("insecure_endpoint");
  });
});

describe("web push refuses endpoints a browser should never have given it", () => {
  it.each([...PRIVATE_ENDPOINTS, ...INSECURE_ENDPOINTS])(
    "does not call out to %s",
    async (endpoint) => {
      const recorder = spyFetch();
      const push = webPush(recorder.impl);
      const outcome = await push.deliver(
        push.render(renderInput({ kind: "native_push" })),
        { channel: "native_push", subscription: subscription(endpoint) },
      );
      expect(outcome.status).toBe("permanent");
      expect(recorder.calls).toHaveLength(0);
    },
  );

  it("never follows a redirect from a public endpoint", async () => {
    const recorder = spyFetch(201);
    const push = webPush(recorder.impl);
    const endpoint = "https://push.example.test/wpush/v2/x";
    const outcome = await push.deliver(
      push.render(renderInput({ kind: "native_push" })),
      { channel: "native_push", subscription: subscription(endpoint) },
    );
    expect(outcome).toEqual({ status: "delivered" });
    expect(recorder.calls[0]?.init?.redirect).toBe("error");
  });
});

describe("teams refuses a private incoming-webhook URL", () => {
  it.each(PRIVATE_ENDPOINTS)("does not post to %s", async (url) => {
    const recorder = spyFetch(200);
    const teams = createTeamsAdapter({ fetchImpl: recorder.impl });
    const outcome = await teams.deliver(
      teams.render(renderInput({ kind: "teams" })),
      { channel: "teams", incomingWebhookUrl: url },
    );
    expect(outcome).toEqual({ status: "permanent", error: "private_endpoint" });
    expect(recorder.calls).toHaveLength(0);
    expect(createTeamsAdapter({ webhookUrl: url }).isConfigured()).toBe(false);
  });

  it("posts with redirects refused", async () => {
    const recorder = spyFetch(200);
    const teams = createTeamsAdapter({
      webhookUrl: "https://example.webhook.office.com/webhookb2/a",
      fetchImpl: recorder.impl,
    });
    await expect(
      teams.deliver(teams.render(renderInput({ kind: "teams" })), {
        channel: "teams",
      }),
    ).resolves.toEqual({ status: "delivered" });
    expect(recorder.calls[0]?.init?.redirect).toBe("error");
  });
});

describe("postPublicOnly", () => {
  const body = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x0a]);
  const init = {
    method: "POST",
    redirect: "error",
    headers: { "content-encoding": "aes128gcm" },
    body,
    signal: AbortSignal.timeout(10_000),
  } satisfies Parameters<typeof postPublicOnly>[1];

  it.each([...PRIVATE_ENDPOINTS, "http://push.example.test/push"])(
    "refuses %s before resolving or opening a socket",
    async (url) => {
      const lookup = vi.fn();
      await expect(postPublicOnly(url, init, lookup)).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
      expect(transport.request).not.toHaveBeenCalled();
    },
  );

  it("refuses a public name that resolves anywhere private", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(
      postPublicOnly("https://push.example.test/push", init, lookup),
    ).rejects.toThrow("Blocked resolved address");
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("pins DNS, sends the binary body intact and does not follow a 302", async () => {
    const sent: Buffer[] = [];
    // SAFETY: the tested postPublicOnly contract calls request(options, callback) and only on/end.
    transport.request.mockImplementation(((
      _options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const request = new Writable({
        write(chunk: Buffer, _encoding, done) {
          sent.push(chunk);
          done();
        },
      });
      request.on("finish", () => {
        const response = new IncomingMessage(new Socket());
        response.statusCode = 302;
        response.headers.location = "https://127.0.0.1/private";
        callback(response);
      });
      return request;
    }) as typeof https.request);
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const response = await postPublicOnly(
      "https://push.example.test/wpush?x=1",
      init,
      lookup,
    );
    expect(response.status).toBe(302);
    expect(Buffer.concat(sent).equals(body)).toBe(true);
    expect(transport.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hostname: "93.184.216.34",
        servername: "push.example.test",
        path: "/wpush?x=1",
        rejectUnauthorized: true,
        agent: false,
      }),
      expect.any(Function),
    );
  });

  it("aborts while DNS is pending without opening a socket", async () => {
    const controller = new AbortController();
    const lookup = vi.fn(() => new Promise<never>(() => {}));
    const result = postPublicOnly(
      "https://push.example.test/push",
      { ...init, signal: controller.signal },
      lookup,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });
});
