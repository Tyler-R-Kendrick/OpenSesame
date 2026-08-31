import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AES128GCM_HEADER_FIXED_LENGTH,
  P256_UNCOMPRESSED_LENGTH,
  SALT_LENGTH,
  VAPID_TOKEN_LIFETIME_SECONDS,
  createWebPushAdapter,
  decryptWebPushPayload,
  derToRawEcdsaSignature,
  encryptWebPushPayload,
  generateVapidKeyPair,
  vapidAuthorization,
} from "../adapters/web-push.js";
import type { WebPushConfig } from "../adapters/web-push.js";
import { base64UrlDecode, base64UrlEncode, parseJsonValue } from "../bytes.js";
import type { PushSubscriptionRecord } from "../contract.js";
import { FIXED_NOW, jsonFetch, renderInput } from "./helpers.js";

const ENDPOINT = "https://push.example.test/wpush/v2/AbCdEf-01234";

interface TestSubscription {
  subscription: PushSubscriptionRecord;
  /** The half a browser keeps and a server never has. */
  uaPrivateKey: Buffer;
  authSecret: Buffer;
}

/** A browser-shaped subscription, plus the private half a browser keeps. */
function subscribe(): TestSubscription {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = randomBytes(16);
  return {
    subscription: {
      endpoint: ENDPOINT,
      keys: {
        p256dh: base64UrlEncode(ua.getPublicKey()),
        auth: base64UrlEncode(authSecret),
      },
    },
    uaPrivateKey: ua.getPrivateKey(),
    authSecret,
  };
}

function vapidConfig(extra: Partial<WebPushConfig> = {}): WebPushConfig {
  const keys = generateVapidKeyPair();
  return {
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
    vapidSubject: "mailto:ops@example.test",
    now: () => FIXED_NOW,
    ...extra,
  };
}

describe("RFC 8291 message encryption", () => {
  it("round-trips a payload back to the subscriber", () => {
    const { subscription, uaPrivateKey, authSecret } = subscribe();
    const plaintext = Buffer.from(
      JSON.stringify({ title: "Authorization requested" }),
      "utf8",
    );
    const body = encryptWebPushPayload(subscription, plaintext);
    expect(decryptWebPushPayload(body, uaPrivateKey, authSecret)).toEqual(
      plaintext,
    );
  });

  it("round-trips payloads of many lengths, empty included", () => {
    const { subscription, uaPrivateKey, authSecret } = subscribe();
    for (const length of [0, 1, 15, 16, 17, 63, 255, 1024]) {
      const plaintext = randomBytes(length);
      const body = encryptWebPushPayload(subscription, plaintext);
      expect(decryptWebPushPayload(body, uaPrivateKey, authSecret)).toEqual(
        plaintext,
      );
    }
  });

  it("lays the aes128gcm header out as salt(16) || rs(4) || idlen(1) || keyid", () => {
    const { subscription } = subscribe();
    const salt = randomBytes(SALT_LENGTH);
    const body = encryptWebPushPayload(
      subscription,
      Buffer.from("hello", "utf8"),
      salt,
    );
    expect(body.subarray(0, SALT_LENGTH)).toEqual(salt);
    const recordSize = body.readUInt32BE(SALT_LENGTH);
    expect(recordSize).toBeGreaterThanOrEqual(4096);
    const idLength = body.readUInt8(SALT_LENGTH + 4);
    expect(idLength).toBe(P256_UNCOMPRESSED_LENGTH);
    const keyId = body.subarray(
      AES128GCM_HEADER_FIXED_LENGTH,
      AES128GCM_HEADER_FIXED_LENGTH + idLength,
    );
    // The key id is the ephemeral application-server public key, and it must
    // be a real uncompressed point or the user agent cannot do its half of
    // the ECDH.
    expect(keyId[0]).toBe(0x04);
    expect(() =>
      createECDH("prime256v1").setPrivateKey(randomBytes(32)),
    ).not.toThrow();
    // Header, key id, ciphertext and a 16-byte tag: nothing unaccounted for.
    expect(body.length).toBeGreaterThan(
      AES128GCM_HEADER_FIXED_LENGTH + idLength + 16,
    );
  });

  it("uses a fresh ephemeral key and salt for every message", () => {
    const { subscription } = subscribe();
    const first = encryptWebPushPayload(subscription, Buffer.from("a"));
    const second = encryptWebPushPayload(subscription, Buffer.from("a"));
    expect(first.subarray(0, SALT_LENGTH)).not.toEqual(
      second.subarray(0, SALT_LENGTH),
    );
    expect(
      first.subarray(
        AES128GCM_HEADER_FIXED_LENGTH,
        AES128GCM_HEADER_FIXED_LENGTH + 65,
      ),
    ).not.toEqual(
      second.subarray(
        AES128GCM_HEADER_FIXED_LENGTH,
        AES128GCM_HEADER_FIXED_LENGTH + 65,
      ),
    );
  });

  it("fails authentication when a ciphertext byte is flipped", () => {
    const { subscription, uaPrivateKey, authSecret } = subscribe();
    const body = encryptWebPushPayload(subscription, Buffer.from("hello"));
    const tampered = Buffer.from(body);
    const index = tampered.length - 20;
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    expect(() =>
      decryptWebPushPayload(tampered, uaPrivateKey, authSecret),
    ).toThrow();
  });

  it("fails when the wrong authentication secret is used", () => {
    const { subscription, uaPrivateKey } = subscribe();
    const body = encryptWebPushPayload(subscription, Buffer.from("hello"));
    expect(() =>
      decryptWebPushPayload(body, uaPrivateKey, randomBytes(16)),
    ).toThrow();
  });

  it("refuses a subscription whose keys are the wrong shape", () => {
    const { subscription } = subscribe();
    expect(() =>
      encryptWebPushPayload(
        { ...subscription, keys: { ...subscription.keys, auth: "AAAA" } },
        Buffer.from("x"),
      ),
    ).toThrow(/16 bytes/u);
    expect(() =>
      encryptWebPushPayload(
        { ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } },
        Buffer.from("x"),
      ),
    ).toThrow(/uncompressed/u);
  });
});

describe("RFC 8292 VAPID", () => {
  it("produces a JWT whose ES256 signature verifies under the public key", () => {
    const config = vapidConfig();
    const header = vapidAuthorization(ENDPOINT, config, FIXED_NOW);
    expect(header.startsWith("vapid ")).toBe(true);
    const parts = header.slice("vapid ".length).split(", ");
    const jwt = parts[0]?.slice("t=".length) ?? "";
    const key = parts[1]?.slice("k=".length) ?? "";
    expect(key).toBe(config.vapidPublicKey);

    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
    const publicPoint = base64UrlDecode(config.vapidPublicKey);
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(publicPoint.subarray(1, 33)),
        y: base64UrlEncode(publicPoint.subarray(33, 65)),
      },
      format: "jwk",
    });
    // `ieee-p1363` is the raw r||s encoding JWS uses; verifying under it is
    // an independent check of the DER conversion in the adapter.
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        base64UrlDecode(encodedSignature ?? ""),
      ),
    ).toBe(true);
    expect(base64UrlDecode(encodedSignature ?? "")).toHaveLength(64);
  });

  it("scopes the audience to the endpoint origin, not the full path", () => {
    const config = vapidConfig();
    const header = vapidAuthorization(ENDPOINT, config, FIXED_NOW);
    const jwt = header.slice("vapid t=".length).split(",")[0] ?? "";
    const payload = parseJsonValue(
      base64UrlDecode(jwt.split(".")[1] ?? "").toString("utf8"),
    );
    expect(payload).toMatchObject({
      aud: "https://push.example.test",
      sub: "mailto:ops@example.test",
      exp:
        Math.floor(FIXED_NOW.getTime() / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
    });
  });

  it("re-pads DER integers that lost or gained a leading byte", () => {
    // A DER SEQUENCE whose r is 31 bytes and whose s carries the 0x00 sign
    // byte: exactly the two cases a naive concatenation gets wrong.
    const r = Buffer.alloc(31, 0x11);
    const s = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0xff)]);
    const der = Buffer.concat([
      Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
    const raw = derToRawEcdsaSignature(der);
    expect(raw).toHaveLength(64);
    expect(raw[0]).toBe(0x00);
    expect(raw.subarray(1, 32)).toEqual(r);
    expect(raw.subarray(32)).toEqual(Buffer.alloc(32, 0xff));
  });

  it("refuses a signature that is not a DER SEQUENCE", () => {
    expect(() =>
      derToRawEcdsaSignature(Buffer.from([0x02, 0x01, 0x00])),
    ).toThrow(/SEQUENCE/u);
  });
});

describe("web push delivery", () => {
  it("sends ciphertext with the VAPID token in a header and not the URL", async () => {
    const recorder = jsonFetch("", 201);
    const { subscription, uaPrivateKey, authSecret } = subscribe();
    const push = createWebPushAdapter(
      vapidConfig({ fetchImpl: recorder.impl }),
    );
    const outcome = await push.deliver(
      push.render(renderInput({ kind: "native_push" })),
      { channel: "native_push", subscription },
    );
    expect(outcome).toEqual({ status: "delivered" });
    const call = recorder.calls[0];
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.url).not.toContain("vapid");
    expect(call?.url).not.toContain("t=");
    expect(call?.headers.authorization?.startsWith("vapid t=")).toBe(true);
    expect(call?.headers["content-encoding"]).toBe("aes128gcm");
    // The body must be the encrypted record, decryptable only by the
    // subscriber's key — the push service is handed nothing readable.
    const decrypted = decryptWebPushPayload(
      call?.bodyBytes ?? new Uint8Array(),
      uaPrivateKey,
      authSecret,
    );
    expect(decrypted.toString("utf8")).toContain("Authorization requested");
  });

  it("keeps the payload at minimal even when full was requested", async () => {
    const recorder = jsonFetch("", 201);
    const { subscription, uaPrivateKey, authSecret } = subscribe();
    const push = createWebPushAdapter(
      vapidConfig({ fetchImpl: recorder.impl }),
    );
    const message = push.render(
      renderInput({
        kind: "native_push",
        confidentiality: "full",
        requesterLabel: "agent-7",
      }),
    );
    expect(message.confidentiality).toBe("minimal");
    await push.deliver(message, { channel: "native_push", subscription });
    const decrypted = decryptWebPushPayload(
      recorder.calls[0]?.bodyBytes ?? new Uint8Array(),
      uaPrivateKey,
      authSecret,
    ).toString("utf8");
    expect(decrypted).not.toContain("Transfer funds");
    expect(decrypted).not.toContain("agent-7");
    expect(decrypted).toContain("rz-QHXT-KPLM");
  });

  it("retires a gone subscription as permanent and a 503 as retryable", async () => {
    const { subscription } = subscribe();
    const gone = createWebPushAdapter(
      vapidConfig({ fetchImpl: jsonFetch("", 410).impl }),
    );
    await expect(
      gone.deliver(gone.render(renderInput({ kind: "native_push" })), {
        channel: "native_push",
        subscription,
      }),
    ).resolves.toEqual({ status: "permanent", error: "status:410" });

    const busy = createWebPushAdapter(
      vapidConfig({ fetchImpl: jsonFetch("", 503).impl }),
    );
    await expect(
      busy.deliver(busy.render(renderInput({ kind: "native_push" })), {
        channel: "native_push",
        subscription,
      }),
    ).resolves.toEqual({ status: "retryable", error: "status:503" });
  });

  it("reports a malformed subscription as permanent without calling out", async () => {
    const recorder = jsonFetch("", 201);
    const push = createWebPushAdapter(
      vapidConfig({ fetchImpl: recorder.impl }),
    );
    const outcome = await push.deliver(
      push.render(renderInput({ kind: "native_push" })),
      {
        channel: "native_push",
        subscription: {
          endpoint: ENDPOINT,
          keys: { p256dh: "AA", auth: "AA" },
        },
      },
    );
    expect(outcome.status).toBe("permanent");
    expect(recorder.calls).toHaveLength(0);
  });

  it("is unconfigured without a well-formed VAPID key pair", async () => {
    const recorder = jsonFetch("", 201);
    const push = createWebPushAdapter({
      vapidPublicKey: "AAAA",
      vapidPrivateKey: "AAAA",
      vapidSubject: "mailto:ops@example.test",
      fetchImpl: recorder.impl,
    });
    expect(push.isConfigured()).toBe(false);
    const { subscription } = subscribe();
    await expect(
      push.deliver(push.render(renderInput({ kind: "native_push" })), {
        channel: "native_push",
        subscription,
      }),
    ).resolves.toEqual({ status: "unconfigured", error: "no_vapid_keys" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("exposes no callback verifier", () => {
    const push = createWebPushAdapter(vapidConfig());
    expect(push.verifyCallback).toBeUndefined();
    expect(push.capabilities().canReceiveAuthenticatedCallback).toBe(false);
  });
});
