import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { openLocalEnvelope, sealLocalEnvelope } from "./local-envelope.js";

it("isolates local customer envelopes and rejects wrap/payload tampering", () => {
  const root = new Uint8Array(32).fill(7);
  const sealed = sealLocalEnvelope(root, "customer-a/session", "secret");
  expect(openLocalEnvelope(root, "customer-a/session", sealed)).toBe("secret");
  expect(sealLocalEnvelope(root, "customer-a/session", "secret")).not.toBe(
    sealed,
  );
  expect(openLocalEnvelope(root, "customer-b/session", sealed)).toBeNull();
  expect(
    openLocalEnvelope(new Uint8Array(32), "customer-a/session", sealed),
  ).toBeNull();
  const packed = Buffer.from(sealed.slice(6), "base64url");
  for (let index = 0; index < packed.length; index += 1) {
    const changed = Buffer.from(packed);
    changed[index] = (changed[index] ?? 0) ^ 1;
    expect(
      openLocalEnvelope(
        root,
        "customer-a/session",
        `osle1.${changed.toString("base64url")}`,
      ),
    ).toBeNull();
  }
  expect(
    openLocalEnvelope(root, "customer-a/session", "osle2.future"),
  ).toBeNull();
  expect(openLocalEnvelope(root, "customer-a/session", "osle1.AA")).toBeNull();
  expect(() =>
    sealLocalEnvelope(new Uint8Array(1), "customer", "secret"),
  ).toThrow();
});

it("opens envelopes written with Node's original default 16-byte GCM tags", () => {
  const root = new Uint8Array(32).fill(7);
  const context = "customer-a/session";
  const key = Buffer.from(
    hkdfSync("sha256", root, "opensesame:local-envelope:v1", context, 32),
  );
  const dataKey = randomBytes(32);
  const wrapIv = randomBytes(12);
  const iv = randomBytes(12);
  const binding = Buffer.from(
    JSON.stringify(["opensesame:local-envelope:v1", context]),
  );
  const encrypt = (
    secret: Buffer,
    nonce: Buffer,
    plain: Buffer,
    aad: Buffer,
  ) => {
    const cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(aad);
    return Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  };
  const header = Buffer.concat([
    wrapIv,
    encrypt(key, wrapIv, dataKey, binding),
    iv,
  ]);
  const body = encrypt(
    dataKey,
    iv,
    Buffer.from("previous envelope"),
    Buffer.concat([binding, header]),
  );
  const previous = `osle1.${Buffer.concat([header, body]).toString("base64url")}`;
  expect(openLocalEnvelope(root, context, previous)).toBe("previous envelope");
});

it.each([1, 4, 8, 12])(
  "rejects tags shortened by %i bytes in either envelope layer",
  (removed) => {
    const root = new Uint8Array(32).fill(7);
    const context = "customer-a/session";
    const sealed = sealLocalEnvelope(root, context, "secret".repeat(16));
    const packed = Buffer.from(sealed.slice(6), "base64url");
    const shortenedPayload = packed.subarray(0, -removed);
    const shortenedWrap = Buffer.concat([
      packed.subarray(0, 60 - removed),
      packed.subarray(60),
    ]);
    for (const changed of [shortenedPayload, shortenedWrap]) {
      expect(
        openLocalEnvelope(
          root,
          context,
          `osle1.${changed.toString("base64url")}`,
        ),
      ).toBeNull();
    }
  },
);
