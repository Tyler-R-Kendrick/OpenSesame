import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { GOOGLE_WALLET_ENV, parseGoogleWalletConfig } from "./config.js";
import {
  GOOGLE_WALLET_CONFIGURATION_POLICY as POLICY,
  googleWalletPemParts,
} from "./google-wallet-policy.js";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../spec/conformance/google-wallet-configuration.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pkcs8 = rsa.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1 = rsa.export({ type: "pkcs1", format: "pem" }).toString();
const ec = generateKeyPairSync("ec", { namedCurve: "P-384" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const keys = new Map<string, string>([
  ["generated_pkcs8_rsa", pkcs8],
  ["generated_pkcs8_rsa_escaped", pkcs8.replace(/\n/g, "\\n")],
  ["generated_pkcs1_rsa", pkcs1],
  ["not-a-private-key", "not-a-private-key"],
  ["oversized", "a".repeat(32769)],
  [
    "invalid_der",
    `-----BEGIN PRIVATE KEY-----\n${"A".repeat(256)}\n-----END PRIVATE KEY-----`,
  ],
  ["generated_ec_pkcs8", ec],
  [
    "invalid_padding",
    `-----BEGIN PRIVATE KEY-----\n${"A".repeat(240)}=A\n-----END PRIVATE KEY-----`,
  ],
]);

function config(issuer: string, classId: string, email: string, key = pkcs8) {
  return parseGoogleWalletConfig({
    [GOOGLE_WALLET_ENV.issuerId]: issuer,
    [GOOGLE_WALLET_ENV.classId]: classId,
    [GOOGLE_WALLET_ENV.serviceAccountEmail]: email,
    [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: key,
    [GOOGLE_WALLET_ENV.publicBaseUrl]: "https://example.test",
    [GOOGLE_WALLET_ENV.origins]: "https://example.test",
  });
}

it("replays shared public-field vectors through the wallet parser", () => {
  for (const item of vectors.public_cases) {
    const parse = () =>
      config(item.issuer_id, item.class_id, item.service_account_email);
    if (item.wallet_accepted ?? item.accepted)
      expect(parse, item.name).not.toThrow();
    else expect(parse, item.name).toThrow();
  }
});

it("replays shared key-envelope and RSA-import vectors", async () => {
  for (const item of vectors.key_cases) {
    const raw = keys.get(item.value);
    if (raw === undefined) throw new Error(`Unknown key fixture ${item.value}`);
    const parts = googleWalletPemParts(raw);
    expect(parts !== null, item.name).toBe(item.pem_accepted ?? item.accepted);
    const parse = () => config("123456", "pass", "x@example.test", raw);
    if (item.pem_accepted ?? item.accepted)
      expect(parse, item.name).not.toThrow();
    else expect(parse, item.name).toThrow();
    if (parts) {
      const bytes = Uint8Array.from(atob(parts.body), (character) =>
        character.charCodeAt(0),
      );
      const imported = crypto.subtle.importKey(
        POLICY.key.format,
        bytes,
        { name: POLICY.key.algorithm, hash: POLICY.key.hash },
        false,
        [POLICY.key.usage],
      );
      if (item.accepted)
        await expect(imported, item.name).resolves.toBeDefined();
      else await expect(imported, item.name).rejects.toThrow();
    }
  }
});
