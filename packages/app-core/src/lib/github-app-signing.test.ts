import { afterEach, expect, it, vi } from "vitest";
import { credentials, keyPair } from "./github-app-direct.test-support.js";
import { signGithubAppJwt } from "./github-app-signing.js";
import { base64ToBytes } from "./native-base64.js";

afterEach(() => vi.restoreAllMocks());
const guard = () => ({
  signal: new AbortController().signal,
  assertCurrent() {},
});

it.each(["pkcs1", "pkcs8"] as const)(
  "signs a verifiable RS256 assertion from %s without exporting the imported key",
  async (type) => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const pem = keyPair.privateKey.export({ type, format: "pem" }).toString();
    const jwt = await signGithubAppJwt(
      credentials.appId,
      pem,
      guard(),
      1800000000,
    );
    const [header = "", claims = "", signature = ""] = jwt.split(".");
    const decode = (part: string) =>
      base64ToBytes(part.replaceAll("-", "+").replaceAll("_", "/"));
    expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toEqual({
      iss: credentials.appId,
      iat: 1799999940,
      exp: 1800000540,
    });
    expect(importKey).toHaveBeenCalledWith(
      "pkcs8",
      expect.any(Uint8Array),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(keyPair.publicKey.export({ type: "spki", format: "der" })),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        new Uint8Array(decode(signature)),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  },
);

it("rejects invalid identifiers, non-RSA keys and oversized PEM without exposing their text", async () => {
  await expect(
    signGithubAppJwt("app\r\nInjected", credentials.privateKey, guard()),
  ).rejects.toThrow("valid GitHub App");
  for (const pem of [
    "credential-secret",
    credentials.privateKey.repeat(50),
    "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
  ])
    await expect(signGithubAppJwt("12", pem, guard())).rejects.toThrow(
      /private key/,
    );
});

it("does not return an assertion after cancellation during key import", async () => {
  const lifetime = new AbortController();
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
    const key = await original(...args);
    lifetime.abort();
    return key;
  });
  await expect(
    signGithubAppJwt("12", credentials.privateKey, {
      signal: lifetime.signal,
      assertCurrent() {},
    }),
  ).rejects.toThrow("cancelled");
});
