import { readdirSync } from "node:fs";
import { BUILTIN_TYPE_IDS } from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import {
  FORMAT_ITEM_TYPE_IDS,
  Random,
  bestItemFormat,
  detectItemFormats,
  generateItemFormat,
  itemFormatCoverage,
  parseItemFormat,
} from "./item-formats/index.js";

function source(seed = 1): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

const now = new Date("2026-01-15T12:00:00.000Z");

function random(seed = 1): Random {
  return new Random(source(seed));
}

function generated(typeId: string, formatId?: string, seed = 1) {
  const result =
    formatId === undefined
      ? generateItemFormat(typeId, { random: random(seed), now })
      : generateItemFormat(typeId, {
          formatId,
          random: random(seed),
          now,
        });
  if (!result) throw new Error(`No generator for ${typeId}`);
  return result;
}

describe("item formats", () => {
  it("recognises a checksum-valid payment card and rejects a mistyped one", () => {
    const match = bestItemFormat("4242 4242 4242 4242");
    expect(match?.typeId).toBe("card");
    expect(match?.label).toBe("Payment card");
    expect(match?.values.brand).toBe("Visa");
    expect(bestItemFormat("4242 4242 4242 4243")?.typeId).not.toBe("card");
  });

  it("does not extract a card number from a TOTP URI, an IBAN or an overlong number", () => {
    const totp = generated("authenticator");
    const iban = generated("bank-account");
    expect(bestItemFormat(totp.canonical ?? "")?.typeId).not.toBe("card");
    expect(bestItemFormat(iban.canonical ?? "")?.typeId).not.toBe("card");
    expect(bestItemFormat("4242 4242 4242 4242 9999")?.typeId).not.toBe("card");
  });

  it("recognises Supabase personal access tokens and secret keys by issuer shape", () => {
    const personal = generated("api-key", "api-key:supabase-pat");
    expect(personal.values.apiKey).toMatch(/^sbp_[0-9a-f]{40}$/u);
    const parsed = parseItemFormat(
      "api-key",
      personal.canonical ?? "",
      "api-key:supabase-pat",
    );
    expect(parsed?.values).toMatchObject({
      apiKey: personal.values.apiKey,
      header: "Authorization",
    });

    const secret = generated("api-key", "api-key:supabase-secret");
    expect(secret.values.apiKey).toMatch(/^sb_secret_[A-Za-z0-9]{40}$/u);
    expect(bestItemFormat(secret.canonical ?? "")?.label).toBe(
      "Supabase secret key",
    );
    expect(parseItemFormat("api-key", "sbp_not-hex")).toBeNull();
  });

  it("carries provider identity into an API credential", () => {
    const generatedCredential = generated(
      "api-credential",
      "api-credential:supabase-pat",
    );
    expect(generatedCredential.values).toMatchObject({
      service: "Supabase",
      apiKey: generatedCredential.canonical,
    });
    expect(bestItemFormat(generatedCredential.canonical ?? "")?.typeId).toBe(
      "api-key",
    );
  });

  it("round-trips a JWT-shaped bearer token", () => {
    const token = generated("token");
    expect(bestItemFormat(token.canonical ?? "")?.typeId).toBe("token");
    expect(parseItemFormat("token", token.canonical ?? "")?.values.token).toBe(
      token.canonical,
    );
  });

  it("round-trips an authenticator seed", () => {
    const totp = generated("authenticator");
    expect(bestItemFormat(totp.canonical ?? "")?.typeId).toBe("authenticator");
    expect(
      parseItemFormat("authenticator", totp.canonical ?? ""),
    ).not.toBeNull();
  });

  it("round-trips IBAN and ABA bank formats", () => {
    const iban = generated("bank-account");
    expect(iban.canonical).toMatch(/^GB\d{2}[A-Z]{4}\d{14}$/u);
    expect(
      parseItemFormat("bank-account", iban.canonical ?? "")?.values.iban,
    ).toBe(iban.canonical);

    const aba = generated("bank-account", "aba-routing-number");
    expect(aba.canonical).toMatch(/^\d{9}$/u);
    expect(
      parseItemFormat("bank-account", aba.canonical ?? "")?.values
        .routingNumber,
    ).toBe(aba.canonical);
    expect(
      parseItemFormat(
        "bank-account",
        `${aba.canonical?.slice(0, 8)}${Number(aba.canonical?.slice(8)) === 0 ? 1 : 0}`,
      ),
    ).toBeNull();
  });

  it("keeps a VIN and an AWS key from being mistaken for a bare TOTP seed", () => {
    const vin = generated("vehicle");
    expect(bestItemFormat(vin.canonical ?? "")?.typeId).toBe("vehicle");
    const aws = generated("api-key", "api-key:aws-access-key");
    expect(bestItemFormat(aws.canonical ?? "")?.typeId).toBe("api-key");
  });

  it("checks an EIP-55 Ethereum address, not only its length", () => {
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(bestItemFormat(checksummed)?.typeId).toBe("crypto-wallet");
    expect(
      bestItemFormat("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"),
    ).toBeNull();
  });

  it("round-trips database URLs, SSH servers, VINs and EVM addresses", () => {
    for (const [typeId, key] of [
      ["database", "connectionString"],
      ["server", "endpoint"],
      ["vehicle", "vin"],
      ["crypto-wallet", "addresses"],
    ] as const) {
      const item = generated(typeId);
      expect(item.canonical, typeId).not.toBeNull();
      const parsed = parseItemFormat(typeId, item.canonical ?? "");
      expect(parsed, typeId).not.toBeNull();
      if (typeId !== "crypto-wallet")
        expect(parsed?.values[key], typeId).toBeDefined();
    }
  });

  it("keeps a password on an SSH URL and an escaped Wi-Fi semicolon", () => {
    const server = generated("server");
    expect(
      parseItemFormat("server", server.canonical ?? "")?.values.password,
    ).toBe(server.values.password);
    const wifi = parseItemFormat("wifi", "WIFI:T:WPA2;S:Bob\\;s Net;P:p;;");
    expect(wifi?.values.ssid).toBe("Bob;s Net");
  });

  it("round-trips Wi-Fi QR payloads and backup-code lists", () => {
    const wifi = generated("wifi");
    expect(wifi.canonical).toContain("WIFI:T:WPA2;S:");
    expect(parseItemFormat("wifi", wifi.canonical ?? "")?.values.security).toBe(
      "wpa2",
    );

    const codes = generated("backup-codes");
    expect(codes.canonical?.split("\n")).toHaveLength(10);
    expect(
      parseItemFormat("backup-codes", codes.canonical ?? ""),
    ).not.toBeNull();
  });

  it("round-trips UUID licences, email accounts and passkey ids", () => {
    for (const typeId of [
      "software-license",
      "email-account",
      "passkey",
    ] as const) {
      const item = generated(typeId);
      expect(item.canonical, typeId).not.toBeNull();
      expect(
        parseItemFormat(typeId, item.canonical ?? ""),
        typeId,
      ).not.toBeNull();
    }
  });

  it("parses SSH keys and certificates but refuses to invent issuer material", () => {
    const publicKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest synthetic@example.test";
    expect(bestItemFormat(publicKey)?.typeId).toBe("ssh-key");
    expect(
      parseItemFormat(
        "ssh-key",
        "sk-ssh-ed25519@openssh.com AAAATest sk@example.test",
      )?.values.keyType,
    ).toBe("ed25519-sk");
    expect(generateItemFormat("ssh-key")).toBeNull();

    const certificate =
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(
      parseItemFormat("certificate", certificate)?.values.certificatePem,
    ).toBe(certificate);
    expect(generateItemFormat("certificate")).toBeNull();
  });

  it("refuses a random bound that cannot be sampled without bias", () => {
    expect(() => random(1).int(0x1_0000_0001)).toThrow(RangeError);
  });

  it("does not call arbitrary prose an API key or a card", () => {
    expect(detectItemFormats("this is ordinary prose")).toEqual([]);
  });

  it("preserves secret whitespace when the type is named", () => {
    const secret = "  leading and trailing  ";
    expect(parseItemFormat("secret", secret)?.values.value).toBe(secret);
  });

  it("treats malformed URL escapes as non-matches", () => {
    expect(() =>
      detectItemFormats("postgresql://demo:%E0%A4%A@db.example.test/app"),
    ).not.toThrow();
  });

  it("has an explicit coverage decision for every built-in and optional item type", () => {
    expect(new Set(FORMAT_ITEM_TYPE_IDS).size).toBe(
      FORMAT_ITEM_TYPE_IDS.length,
    );
    const optional = readdirSync(
      new URL("../../../marketplace/item-types/optional/", import.meta.url),
    )
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/u, ""));
    for (const id of [...BUILTIN_TYPE_IDS, ...optional]) {
      expect(FORMAT_ITEM_TYPE_IDS, id).toContain(id);
    }
    for (const id of FORMAT_ITEM_TYPE_IDS) {
      const coverage = itemFormatCoverage(id);
      if (coverage.status === "unsupported")
        expect(coverage.reason, id).not.toBe("");
      else expect(coverage.formats.length, id).toBeGreaterThan(0);
    }
  });

  it("generates values that parse again for every supported type", () => {
    for (const id of FORMAT_ITEM_TYPE_IDS) {
      const coverage = itemFormatCoverage(id);
      if (coverage.status !== "parser+generator") continue;
      const item = generated(id);
      if (item.canonical === null) continue;
      const parsed = parseItemFormat(id, item.canonical, item.formatId);
      expect(parsed, id).not.toBeNull();
    }
  });
});
