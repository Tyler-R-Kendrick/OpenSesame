import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WALLET_ENV,
  type GoogleWalletEnabled,
  parseGoogleWalletConfig,
} from "./config.js";
import {
  type RotatingBarcodeSeed,
  WalletLauncherError,
  assertLauncherPublicSafe,
  buildLauncherProvisioningObject,
  buildLauncherPublicObject,
  launcherObjectId,
  launcherUrl,
} from "./registration.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ISSUER_ID = "3388000000022125777";
const BASE_URL = "https://interactions.example.test";

function config(): GoogleWalletEnabled {
  const parsed = parseGoogleWalletConfig({
    [GOOGLE_WALLET_ENV.issuerId]: ISSUER_ID,
    [GOOGLE_WALLET_ENV.classId]: "interaction",
    [GOOGLE_WALLET_ENV.serviceAccountEmail]:
      "wallet@opensesame-test.iam.gserviceaccount.com",
    [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: privateKey,
    [GOOGLE_WALLET_ENV.publicBaseUrl]: BASE_URL,
    [GOOGLE_WALLET_ENV.origins]: BASE_URL,
  });
  if (!parsed.enabled) throw new Error("test configuration is not enabled");
  return parsed;
}

const SEED: RotatingBarcodeSeed = {
  key: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  valueLength: 6,
};

describe("launcherUrl — bound to the deployment origin", () => {
  it("builds a /w/ launcher URL under the configured base", () => {
    expect(launcherUrl(config(), "dev-laptop")).toBe(
      `${BASE_URL}/w/dev-laptop`,
    );
  });

  it("refuses a registration id that is not path-and-id safe", () => {
    expect(() => launcherUrl(config(), "not/allowed")).toThrow(
      WalletLauncherError,
    );
    expect(() => launcherUrl(config(), "")).toThrow(WalletLauncherError);
  });
});

describe("launcherObjectId — derived and stable", () => {
  it("is issuer-prefixed, marked, and stable per registration", () => {
    const first = launcherObjectId(config(), "dev-laptop");
    const again = launcherObjectId(config(), "dev-laptop");
    const other = launcherObjectId(config(), "work-phone");
    expect(first.startsWith(`${ISSUER_ID}.l_`)).toBe(true);
    expect(first).toBe(again);
    expect(other).not.toBe(first);
    // The registration id is not spelled out in the id it produces.
    expect(first).not.toContain("dev-laptop");
  });
});

describe("the public launcher object — persistent, no seed (T-26/T-28)", () => {
  it("carries a static launcher barcode and no expiry interval", () => {
    const object = buildLauncherPublicObject(config(), {
      registrationId: "dev-laptop",
      header: "Tyler's laptop",
    });
    expect(object.barcode).toEqual({
      type: "QR_CODE",
      value: `${BASE_URL}/w/dev-laptop`,
    });
    // Persistent: a launcher does not lapse on its own, so no validTimeInterval.
    expect(object).not.toHaveProperty("validTimeInterval");
    // No field a seed could ride.
    expect(object).not.toHaveProperty("rotatingBarcode");
    expect(object.cardTitle.defaultValue.value).toBe("OpenSesame");
    expect(object.header.defaultValue.value).toBe("Tyler's laptop");
  });

  it("omits the subheader when there is nothing to say", () => {
    const object = buildLauncherPublicObject(config(), {
      registrationId: "dev-laptop",
      header: "Tyler's laptop",
    });
    expect(object).not.toHaveProperty("subheader");
  });

  it("refuses an empty header", () => {
    expect(() =>
      buildLauncherPublicObject(config(), {
        registrationId: "dev-laptop",
        header: "   ",
      }),
    ).toThrow(WalletLauncherError);
  });
});

describe("the provisioning object — the only home of a seed (T-28)", () => {
  it("adds a rotating barcode with the seed under totpDetails", () => {
    const object = buildLauncherProvisioningObject(
      config(),
      { registrationId: "dev-laptop", header: "Tyler's laptop" },
      SEED,
    );
    expect(object.rotatingBarcode?.totpDetails.parameters).toEqual([
      { key: SEED.key, valueLength: 6 },
    ]);
    expect(object.rotatingBarcode?.type).toBe("TOTP");
  });

  it("is byte-identical to the public object when no seed is given", () => {
    const input = { registrationId: "dev-laptop", header: "Tyler's laptop" };
    expect(buildLauncherProvisioningObject(config(), input)).toEqual(
      buildLauncherPublicObject(config(), input),
    );
  });
});

describe("assertLauncherPublicSafe — the seed can never reach a JWT (T-27)", () => {
  it("passes a genuine public object", () => {
    const object = buildLauncherPublicObject(config(), {
      registrationId: "dev-laptop",
      header: "Tyler's laptop",
    });
    expect(() => assertLauncherPublicSafe(object)).not.toThrow();
  });

  it("refuses a public object that grew a rotating barcode", () => {
    // A widening cast or a stray spread is the mistake this guards. The
    // provisioning object has the seed; feeding it to the JWT path must fail.
    const provisioning = buildLauncherProvisioningObject(
      config(),
      { registrationId: "dev-laptop", header: "Tyler's laptop" },
      SEED,
    );
    expect(() => assertLauncherPublicSafe(provisioning)).toThrow(
      WalletLauncherError,
    );
  });

  it("refuses a header carrying a display-shaped secret through the inherited gate", () => {
    // buildLauncherPublicObject screens on the way out, so this refuses before
    // it ever returns an object.
    expect(() =>
      buildLauncherPublicObject(config(), {
        registrationId: "dev-laptop",
        header: "Bearer ya29.a0AfB_byC9x1QzP",
      }),
    ).toThrow();
  });
});
