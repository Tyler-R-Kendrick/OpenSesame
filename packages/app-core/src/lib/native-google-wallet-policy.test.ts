import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOOGLE_WALLET_CONFIGURATION_POLICY } from "@opensesame/wallet/google-wallet-policy";
import { describe, expect, it } from "vitest";
import { googleWalletConfigurationPolicy } from "../../scripts/emit-google-wallet-configuration.mjs";
import {
  validateGoogleWalletKey,
  validateGoogleWalletPublic,
} from "./native-google-wallet-configuration.js";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../spec/conformance/google-wallet-configuration.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

describe("Google Wallet shared configuration policy", () => {
  it("matches the shared catalog without drift", () => {
    expect(GOOGLE_WALLET_CONFIGURATION_POLICY).toEqual(
      googleWalletConfigurationPolicy(),
    );
    for (const value of Object.values(GOOGLE_WALLET_CONFIGURATION_POLICY))
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects an unsupported class qualification policy", () => {
    const policy = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../spec/connectors/google-wallet-configuration.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    policy.class_id.qualification = "arbitrary-issuer";
    expect(() => googleWalletConfigurationPolicy(policy)).toThrow();
  });

  it("replays shared public-field conformance vectors", () => {
    expect(vectors.provider_id).toBe("google-wallet");
    for (const item of vectors.public_cases) {
      const validate = () =>
        validateGoogleWalletPublic({
          issuer_id: item.issuer_id,
          class_id: item.class_id,
          service_account_email: item.service_account_email,
        });
      if (item.accepted) expect(validate, item.name).not.toThrow();
      else expect(validate, item.name).toThrow();
    }
  });

  it("replays shared private-key conformance vectors", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8 = pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const pkcs1 = pair.privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
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
    for (const item of vectors.key_cases) {
      const key = keys.get(item.value);
      if (key === undefined)
        throw new Error(`Unknown key fixture ${item.value}`);
      if (item.accepted)
        await expect(
          validateGoogleWalletKey(key),
          item.name,
        ).resolves.toBeUndefined();
      else
        await expect(validateGoogleWalletKey(key), item.name).rejects.toThrow();
    }
  });
});
