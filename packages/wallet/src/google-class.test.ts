import { generateKeyPairSync, verify } from "node:crypto";
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import type { GoogleWalletEnabled } from "./config.js";
import type { GoogleResponseReader } from "./google-class.js";
import { createGoogleClient } from "./google-client.js";
import { WalletRequestError } from "./provider.js";

const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const config: GoogleWalletEnabled = {
  enabled: true,
  issuerId: "3388000000022125777",
  classId: "3388000000022125777.operator",
  serviceAccountEmail: "wallet@operator-project.iam.gserviceaccount.com",
  serviceAccountKeyPem: pair.privateKey,
  publicBaseUrl: "https://operator.example.test/OpenSesame",
  origins: ["https://operator.example.test"],
};
const now = () => new Date("2026-10-19T00:00:00Z");
const tokenUrl = "https://oauth2.googleapis.com/token";
const classUrl = `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${config.classId}`;
const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function oracle(
  classResponse = json({ id: config.classId }),
  readResponseJson?: GoogleResponseReader,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      expect(String(url)).toBe(tokenUrl);
      expect(init?.method).toBe("POST");
      const form = new URLSearchParams(String(init?.body));
      expect([...form.keys()].sort()).toEqual(["assertion", "grant_type"]);
      expect(form.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      const [header, claims, signature] = (form.get("assertion") ?? "").split(
        ".",
      );
      expect(
        JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
      ).toEqual({ alg: "RS256", typ: "JWT" });
      expect(
        JSON.parse(Buffer.from(claims ?? "", "base64url").toString()),
      ).toEqual({
        iss: config.serviceAccountEmail,
        aud: tokenUrl,
        scope: "https://www.googleapis.com/auth/wallet_object.issuer",
        iat: now().getTime() / 1000,
        exp: now().getTime() / 1000 + 3600,
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          pair.publicKey,
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      return json({
        access_token: "owned-protocol-wallet-access",
        expires_in: 3600,
      });
    }
    expect(String(url)).toBe(classUrl);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer owned-protocol-wallet-access",
    );
    expect(init?.body).toBeUndefined();
    return classResponse;
  });
  const options: Parameters<typeof createGoogleClient>[0] = {
    config,
    fetchImpl,
    now,
  };
  if (readResponseJson) options.readResponseJson = readResponseJson;
  return {
    calls,
    fetchImpl,
    client: createGoogleClient(options),
  };
}

describe("Google Wallet exact class proof", () => {
  it("signs the official issuer assertion and reads only the configured class using injected transport", async () => {
    const o = oracle();
    await expect(o.client.verifyGenericClass()).resolves.toBeUndefined();
    expect(o.calls.map((row) => row.url)).toEqual([tokenUrl, classUrl]);
  });

  it("reuses the existing screened Save URL signer and emits an independently verifiable JWT", async () => {
    const o = oracle();
    const url = await o.client.signSaveUrl([
      { id: `${config.issuerId}.owned` },
    ]);
    expect(o.calls).toEqual([]);
    expect(url.startsWith("https://pay.google.com/gp/v/save/")).toBe(true);
    const [header, claims, signature] = url
      .slice("https://pay.google.com/gp/v/save/".length)
      .split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        pair.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(claims ?? "", "base64url").toString()),
    ).toEqual({
      iss: config.serviceAccountEmail,
      aud: "google",
      typ: "savetowallet",
      iat: now().getTime() / 1000,
      origins: config.origins,
      payload: { genericObjects: [{ id: `${config.issuerId}.owned` }] },
    });
    await expect(
      o.client.signSaveUrl([{ api_key: "never-emit" }]),
    ).rejects.toThrow();
  });

  it.each([401, 403, 404, 429, 500])(
    "rejects class HTTP %i without exposing its body",
    async (status) => {
      const o = oracle(json({ secret: "private-upstream-error" }, status));
      await expect(o.client.verifyGenericClass()).rejects.toMatchObject({
        status,
        message: "Google Wallet could not verify the configured pass class.",
      });
    },
  );

  it.each([null, [], {}, { id: "other-issuer.class" }])(
    "rejects a missing or different class identity: %j",
    async (body) => {
      const o = oracle(json(body));
      await expect(o.client.verifyGenericClass()).rejects.toBeInstanceOf(
        WalletRequestError,
      );
    },
  );

  it("rejects malformed JSON and a followed redirect", async () => {
    await expect(
      oracle(new Response("private invalid json")).client.verifyGenericClass(),
    ).rejects.toThrow("Google Wallet could not verify");
    const response = json({ id: config.classId });
    Object.defineProperty(response, "redirected", { value: true });
    await expect(oracle(response).client.verifyGenericClass()).rejects.toThrow(
      "Google Wallet could not verify",
    );
  });

  it("does not send a class request after token authorization is refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ private: "must-not-reflect" }, 401),
    );
    const client = createGoogleClient({ config, fetchImpl, now });
    await expect(client.verifyGenericClass()).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(tokenUrl);
  });
});

it("hands original token and class Responses to the captured native body consumer with their separate limits", async () => {
  const response = json({ id: config.classId });
  const read = vi.fn<GoogleResponseReader>((value) => value.json());
  const own = oracle(response, read);
  await own.client.verifyGenericClass();
  expect(read.mock.calls.map(([, limit]) => limit)).toEqual([16384, 65536]);
  expect(read.mock.calls[1]?.[0]).toBe(response);
});

it.each([
  null,
  [],
  {},
  { access_token: 7, expires_in: 3600 },
  { access_token: "", expires_in: 3600 },
  { access_token: "owned-wallet-token", expires_in: "3600" },
  { access_token: "owned-wallet-token", expires_in: null },
  { access_token: "owned-wallet-token", expires_in: 0 },
  { access_token: "owned-wallet-token", expires_in: -1 },
])("rejects unusable token reply %j before any class request", async (body) => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json(body));
  const client = createGoogleClient({ config, fetchImpl, now });
  await expect(client.verifyGenericClass()).rejects.toBeInstanceOf(
    WalletRequestError,
  );
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(tokenUrl);
});
it("preserves the existing absent-expiry default for a valid token before exact class proof", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({ access_token: "owned-protocol-wallet-access" }),
    )
    .mockResolvedValueOnce(json({ id: config.classId }));
  const client = createGoogleClient({ config, fetchImpl, now });
  await expect(client.verifyGenericClass()).resolves.toBeUndefined();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(tokenUrl);
  expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(classUrl);
});
