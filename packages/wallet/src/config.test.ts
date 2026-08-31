import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WALLET_ENV,
  WalletConfigError,
  type WalletEnvSource,
  parseGoogleWalletConfig,
} from "./config.js";

/**
 * A throwaway keypair, generated here. The suite never touches a real Google
 * service account: a committed key would be a published key, and a test that
 * needed live credentials would be a test nobody runs.
 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const COMPLETE_ENV = {
  [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
  [GOOGLE_WALLET_ENV.classId]: "interaction",
  [GOOGLE_WALLET_ENV.serviceAccountEmail]:
    "wallet@opensesame-test.iam.gserviceaccount.com",
  [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: privateKey,
  [GOOGLE_WALLET_ENV.publicBaseUrl]: "https://interactions.example.test",
  [GOOGLE_WALLET_ENV.origins]: "https://interactions.example.test",
};

function envWith(overrides: WalletEnvSource): WalletEnvSource {
  return { ...COMPLETE_ENV, ...overrides };
}

function envWithout(name: string): WalletEnvSource {
  return Object.fromEntries(
    Object.entries(COMPLETE_ENV).filter(([key]) => key !== name),
  );
}

function configError(env: WalletEnvSource): WalletConfigError {
  try {
    parseGoogleWalletConfig(env);
  } catch (error) {
    if (error instanceof WalletConfigError) return error;
    throw error;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("parseGoogleWalletConfig — nothing configured", () => {
  it("is disabled on an empty environment", () => {
    expect(parseGoogleWalletConfig({})).toEqual({ enabled: false });
  });

  it("treats blank values as absent, not as a partial configuration", () => {
    const blanked = Object.fromEntries(
      Object.values(GOOGLE_WALLET_ENV).map((name) => [name, "   "]),
    );
    expect(parseGoogleWalletConfig(blanked)).toEqual({ enabled: false });
  });
});

describe("parseGoogleWalletConfig — partial configuration", () => {
  it("refuses every single-variable-missing combination", () => {
    for (const name of Object.values(GOOGLE_WALLET_ENV)) {
      const error = configError(envWithout(name));
      expect(error.variables).toContain(name);
      expect(error.message).toContain("partially configured");
    }
  });

  it("names every missing variable, not just the first", () => {
    const error = configError({
      [GOOGLE_WALLET_ENV.issuerId]: "3388000000022125777",
    });
    expect(error.variables).toEqual([
      GOOGLE_WALLET_ENV.classId,
      GOOGLE_WALLET_ENV.serviceAccountEmail,
      GOOGLE_WALLET_ENV.serviceAccountKeyPem,
      GOOGLE_WALLET_ENV.publicBaseUrl,
      GOOGLE_WALLET_ENV.origins,
    ]);
  });
});

describe("parseGoogleWalletConfig — a complete configuration", () => {
  it("qualifies a bare class suffix with the issuer id", () => {
    const config = parseGoogleWalletConfig(COMPLETE_ENV);
    expect(config.enabled).toBe(true);
    if (!config.enabled) return;
    expect(config.classId).toBe("3388000000022125777.interaction");
    expect(config.issuerId).toBe("3388000000022125777");
    expect(config.origins).toEqual(["https://interactions.example.test"]);
  });

  it("accepts an already-qualified class id", () => {
    const config = parseGoogleWalletConfig(
      envWith({
        [GOOGLE_WALLET_ENV.classId]: "3388000000022125777.interaction",
      }),
    );
    expect(config.enabled && config.classId).toBe(
      "3388000000022125777.interaction",
    );
  });

  it("refuses a class belonging to another issuer", () => {
    const error = configError(
      envWith({ [GOOGLE_WALLET_ENV.classId]: "9999999999999999.interaction" }),
    );
    expect(error.variables).toContain(GOOGLE_WALLET_ENV.classId);
  });

  it("accepts a PEM whose newlines survived as backslash-n", () => {
    const escaped = privateKey.replace(/\n/gu, "\\n");
    const config = parseGoogleWalletConfig(
      envWith({ [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: escaped }),
    );
    expect(config.enabled && config.serviceAccountKeyPem).toBe(privateKey);
  });

  it("splits and normalizes a comma-separated origin list", () => {
    const config = parseGoogleWalletConfig(
      envWith({
        [GOOGLE_WALLET_ENV.origins]:
          "https://interactions.example.test , https://console.example.test",
      }),
    );
    expect(config.enabled && config.origins).toEqual([
      "https://interactions.example.test",
      "https://console.example.test",
    ]);
  });
});

describe("parseGoogleWalletConfig — malformed values", () => {
  it("refuses a non-numeric issuer id", () => {
    expect(
      configError(envWith({ [GOOGLE_WALLET_ENV.issuerId]: "issuer-one" }))
        .variables,
    ).toContain(GOOGLE_WALLET_ENV.issuerId);
  });

  it("refuses an address that is not an email", () => {
    expect(
      configError(
        envWith({ [GOOGLE_WALLET_ENV.serviceAccountEmail]: "not-an-address" }),
      ).variables,
    ).toContain(GOOGLE_WALLET_ENV.serviceAccountEmail);
  });

  it("refuses a PKCS#1 key by name rather than failing inside JOSE", () => {
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
    const error = configError(
      envWith({ [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: pkcs1 }),
    );
    expect(error.message).toContain("PKCS#1");
  });

  it("refuses anything that is not a private key at all", () => {
    expect(
      configError(
        envWith({ [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: "hunter2" }),
      ).variables,
    ).toContain(GOOGLE_WALLET_ENV.serviceAccountKeyPem);
  });

  it("refuses a plaintext public base URL", () => {
    expect(
      configError(
        envWith({ [GOOGLE_WALLET_ENV.publicBaseUrl]: "http://example.test" }),
      ).message,
    ).toContain("https");
  });

  it("refuses a public base URL carrying credentials", () => {
    expect(
      configError(
        envWith({
          [GOOGLE_WALLET_ENV.publicBaseUrl]: "https://user:pw@example.test",
        }),
      ).message,
    ).toContain("credentials");
  });

  it("refuses a public base URL carrying a query string", () => {
    expect(
      configError(
        envWith({
          [GOOGLE_WALLET_ENV.publicBaseUrl]: "https://example.test/?debug=1",
        }),
      ).message,
    ).toContain("no query or fragment");
  });

  it("refuses an origin with a path, which Google would silently ignore", () => {
    expect(
      configError(
        envWith({
          [GOOGLE_WALLET_ENV.origins]: "https://example.test/wallet",
        }),
      ).message,
    ).toContain("bare origin");
  });

  it("refuses a plaintext origin", () => {
    expect(
      configError(
        envWith({ [GOOGLE_WALLET_ENV.origins]: "http://example.test" }),
      ).message,
    ).toContain("https");
  });
});
