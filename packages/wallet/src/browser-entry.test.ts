import { generateKeyPairSync, verify } from "node:crypto";
import {
  GOOGLE_WALLET_ENV,
  parseGoogleWalletConfig,
} from "@opensesame/wallet/config";
import { createGoogleClient } from "@opensesame/wallet/google-client";
import { expect, it, vi } from "vitest";

const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const issuer = "3388000000022125777";
const origin = "https://operator.example.test";
const email = "wallet@operator-project.iam.gserviceaccount.com";
const now = () => new Date("2026-10-24T00:00:00Z");
const env = {
  [GOOGLE_WALLET_ENV.issuerId]: issuer,
  [GOOGLE_WALLET_ENV.classId]: "operator",
  [GOOGLE_WALLET_ENV.serviceAccountEmail]: email,
  [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: pair.privateKey,
  [GOOGLE_WALLET_ENV.publicBaseUrl]: `${origin}/OpenSesame`,
  [GOOGLE_WALLET_ENV.origins]: origin,
};
const object = {
  id: `${issuer}.operator-pass`,
  classId: `${issuer}.operator`,
  state: "ACTIVE",
  cardTitle: { defaultValue: { language: "en-US", value: "Operator pass" } },
  header: { defaultValue: { language: "en-US", value: "Public pass" } },
};
function client() {
  const config = parseGoogleWalletConfig(env);
  if (!config.enabled) throw new Error("Missing owned signer configuration");
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("Local Save signing must not open a network request");
  });
  return { client: createGoogleClient({ config, now, fetchImpl }), fetchImpl };
}

it("the public browser subpaths sign the documented Google Save envelope with an independently verified RS256 signature", async () => {
  const own = client();
  const url = new URL(await own.client.signSaveUrl([object]));
  expect(url.origin).toBe("https://pay.google.com");
  expect(url.pathname.startsWith("/gp/v/save/")).toBe(true);
  const jwt = url.pathname.slice("/gp/v/save/".length);
  const [header, claims, signature, extra] = jwt.split(".");
  if (!header || !claims || !signature || extra)
    throw new Error("Invalid Save envelope");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
    iss: email,
    aud: "google",
    typ: "savetowallet",
    iat: now().getTime() / 1000,
    origins: [origin],
    payload: { genericObjects: [object] },
  });
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      pair.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}x`),
      pair.publicKey,
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(false);
  expect(url.href).not.toContain("PRIVATE KEY");
  expect(own.fetchImpl).not.toHaveBeenCalled();
});

it("the exported signer preserves the shared payload refusal before any Google delivery", async () => {
  const own = client();
  await expect(
    own.client.signSaveUrl([
      { ...object, access_token: "private-fixture-token" },
    ]),
  ).rejects.toThrow();
  expect(own.fetchImpl).not.toHaveBeenCalled();
});
