import { describe, expect, it } from "vitest";

import { generateVapidKeyPair } from "../adapters/web-push.js";
import {
  WEBPUSH_PRIVATE_KEY_ENV,
  WEBPUSH_PUBLIC_KEY_ENV,
  WEBPUSH_SUBJECT_ENV,
  WebPushConfigError,
  type WebPushEnv,
  isVapidPublicKey,
  loadVapidIdentity,
  readVapidPublicKey,
} from "../webpush-env.js";

const pair = generateVapidKeyPair();
const other = generateVapidKeyPair();

function env(overrides: WebPushEnv = {}) {
  return {
    [WEBPUSH_PUBLIC_KEY_ENV]: pair.publicKey,
    [WEBPUSH_PRIVATE_KEY_ENV]: pair.privateKey,
    [WEBPUSH_SUBJECT_ENV]: "mailto:ops@example.test",
    ...overrides,
  };
}

describe("Web Push environment", () => {
  it("loads a matching pair with a contact", () => {
    expect(loadVapidIdentity(env())).toEqual({
      vapidPublicKey: pair.publicKey,
      vapidPrivateKey: pair.privateKey,
      vapidSubject: "mailto:ops@example.test",
    });
    expect(
      loadVapidIdentity(env({ [WEBPUSH_SUBJECT_ENV]: "https://os.example/c" })),
    ).toMatchObject({ vapidSubject: "https://os.example/c" });
  });

  it("is simply absent when there is no private key, however the rest is set", () => {
    expect(loadVapidIdentity({})).toBeUndefined();
    expect(
      loadVapidIdentity({ [WEBPUSH_PUBLIC_KEY_ENV]: pair.publicKey }),
    ).toBeUndefined();
    expect(
      loadVapidIdentity(env({ [WEBPUSH_PRIVATE_KEY_ENV]: "  " })),
    ).toBeUndefined();
  });

  it("refuses a private key that does not belong to the public key", () => {
    expect(() =>
      loadVapidIdentity(env({ [WEBPUSH_PRIVATE_KEY_ENV]: other.privateKey })),
    ).toThrow(/does not match/u);
    expect(() =>
      loadVapidIdentity(env({ [WEBPUSH_PUBLIC_KEY_ENV]: other.publicKey })),
    ).toThrow(WebPushConfigError);
  });

  it("refuses a private key with no public key, or without a contact", () => {
    expect(() =>
      loadVapidIdentity(env({ [WEBPUSH_PUBLIC_KEY_ENV]: undefined })),
    ).toThrow(/PUBLIC_KEY is not/u);
    for (const subject of [
      undefined,
      "",
      "ops@example.test",
      "http://x.test",
    ]) {
      expect(() =>
        loadVapidIdentity(env({ [WEBPUSH_SUBJECT_ENV]: subject })),
      ).toThrow(/mailto: or https:/u);
    }
  });

  it("refuses malformed keys", () => {
    for (const bad of ["AAAA", "not base64url!", `${pair.privateKey}AA`]) {
      expect(() =>
        loadVapidIdentity(env({ [WEBPUSH_PRIVATE_KEY_ENV]: bad })),
      ).toThrow(WebPushConfigError);
    }
    for (const bad of ["BPubKey", "AAAA", `${pair.publicKey}=`]) {
      expect(() =>
        readVapidPublicKey({ [WEBPUSH_PUBLIC_KEY_ENV]: bad }),
      ).toThrow(WebPushConfigError);
    }
  });

  it("reads the public key on its own, for a process that only serves it", () => {
    expect(readVapidPublicKey({})).toBe("");
    expect(
      readVapidPublicKey({ [WEBPUSH_PUBLIC_KEY_ENV]: pair.publicKey }),
    ).toBe(pair.publicKey);
    expect(isVapidPublicKey(pair.publicKey)).toBe(true);
    expect(isVapidPublicKey(pair.privateKey)).toBe(false);
  });
});
