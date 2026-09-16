import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WALLET_ENV,
  type GoogleWalletEnabled,
  parseGoogleWalletConfig,
} from "./config.js";
import {
  NullLauncherProvider,
  createGoogleLauncherProvider,
  createWalletLauncherProvider,
  newRotatingBarcodeSeed,
} from "./launcher.js";
import { WalletNotConfiguredError } from "./provider.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ISSUER_ID = "3388000000022125777";
const BASE_URL = "https://interactions.example.test";
const SAVE_PREFIX = "https://pay.google.com/gp/v/save/";
const NOW = new Date("2026-08-31T12:00:00.000Z");

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

interface RecordedCall {
  url: string;
  method: string;
  body: string;
}

interface FetchRecorder {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

function recorder(statuses: ReadonlyArray<number>): FetchRecorder {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    });
    const status = statuses[calls.length - 1] ?? 200;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "test-access-token", expires_in: 3599 }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function provider(fetchImpl: typeof fetch) {
  return createGoogleLauncherProvider({
    config: config(),
    fetchImpl,
    now: () => NOW,
  });
}

const INPUT = { registrationId: "dev-laptop", header: "Tyler's laptop" };

async function decodeSaveUrl(saveUrl: string) {
  expect(saveUrl.startsWith(SAVE_PREFIX)).toBe(true);
  const key = await importSPKI(publicKey, "RS256");
  const { payload } = await jwtVerify(saveUrl.slice(SAVE_PREFIX.length), key);
  return payload;
}

describe("newRotatingBarcodeSeed", () => {
  it("yields a fresh base32 secret each time", () => {
    const a = newRotatingBarcodeSeed();
    const b = newRotatingBarcodeSeed();
    expect(a.key).toMatch(/^[A-Z2-7]+$/u);
    expect(a.key.length).toBeGreaterThanOrEqual(32);
    expect(a.key).not.toBe(b.key);
    expect(a.valueLength).toBe(6);
  });
});

describe("capabilities", () => {
  it("reports issue offline, and provisioning/disable behind a fetch", () => {
    expect(provider(recorder([]).fetchImpl).capabilities()).toEqual({
      provider: "google",
      available: true,
      issue: true,
      rotatingBarcode: true,
      disable: true,
    });
  });

  it("drops provisioning and disable on a runtime with no fetch", () => {
    const original = globalThis.fetch;
    Reflect.deleteProperty(globalThis, "fetch");
    try {
      const caps = createGoogleLauncherProvider({
        config: config(),
        now: () => NOW,
      }).capabilities();
      expect(caps.issue).toBe(true);
      expect(caps.rotatingBarcode).toBe(false);
      expect(caps.disable).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("issueLauncher — a persistent launcher link (T-26)", () => {
  it("signs offline, over a static-barcode object with no expiry", async () => {
    const rec = recorder([]);
    const artifact = await provider(rec.fetchImpl).issueLauncher(INPUT);
    // Issuance is pure signing: nothing is sent.
    expect(rec.calls).toHaveLength(0);
    expect(artifact.provider).toBe("google");
    expect(artifact.passId.startsWith(`${ISSUER_ID}.l_`)).toBe(true);

    const payload = await decodeSaveUrl(artifact.saveUrl);
    expect(payload.typ).toBe("savetowallet");
    // Assert over the emitted bytes rather than narrowing jose's open payload:
    // the launcher URL is the static barcode, and no expiry interval is signed.
    const decoded = JSON.stringify(payload);
    expect(decoded).toContain(`${BASE_URL}/w/dev-laptop`);
    expect(decoded).toContain('"type":"QR_CODE"');
    expect(decoded).not.toContain("validTimeInterval");
  });
});

describe("the seed never rides the Save JWT (T-27)", () => {
  it("carries no rotating barcode or seed in the signed launcher link", async () => {
    const artifact = await provider(recorder([]).fetchImpl).issueLauncher(
      INPUT,
    );
    // The whole signed link, as text, must not contain the seed vocabulary.
    const decoded = JSON.stringify(await decodeSaveUrl(artifact.saveUrl));
    expect(decoded.toLowerCase()).not.toContain("rotatingbarcode");
    expect(decoded.toLowerCase()).not.toContain("totpdetails");
  });

  it("provisions the seed only over the authenticated REST channel", async () => {
    // token, insert(object), patch(rotatingBarcode)
    const rec = recorder([200, 200, 200]);
    await provider(rec.fetchImpl).provisionRotatingBarcode?.(INPUT);

    expect(rec.calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    const insert = rec.calls[1];
    expect(insert?.method).toBe("POST");
    expect(insert?.url).toContain("/genericObject");
    // The public insert carries no seed.
    expect(insert?.body.toLowerCase()).not.toContain("totpdetails");

    const patch = rec.calls[2];
    expect(patch?.method).toBe("PATCH");
    // The seed rides here, and only here.
    expect(patch?.body).toContain("totpDetails");
    expect(patch?.body).toContain("TOTP");
    // No Save JWT prefix appears in any request body: the seed is never signed.
    for (const call of rec.calls) {
      expect(call.body).not.toContain(SAVE_PREFIX);
    }
  });
});

describe("disableLauncher — best-effort Google side (T-29)", () => {
  it("expires the object by its derived id, sending nothing else", async () => {
    const rec = recorder([200, 200]);
    await provider(rec.fetchImpl).disableLauncher?.({
      registrationId: "dev-laptop",
    });
    const patch = rec.calls[1];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain(`${ISSUER_ID}.l_`);
    expect(patch?.body).toBe('{"state":"EXPIRED"}');
  });

  it("surfaces a Google outage as a typed error, not a silent success", async () => {
    const exploding: typeof fetch = () => {
      throw new Error("ECONNREFUSED walletobjects.googleapis.com");
    };
    await expect(
      provider(exploding).disableLauncher?.({ registrationId: "dev-laptop" }),
    ).rejects.toMatchObject({ name: "WalletRequestError", status: 0 });
  });
});

describe("createWalletLauncherProvider — configuration-driven", () => {
  it("yields a null launcher provider on an empty environment", async () => {
    const launcher = createWalletLauncherProvider({});
    expect(launcher).toBeInstanceOf(NullLauncherProvider);
    expect(launcher.capabilities().available).toBe(false);
    await expect(launcher.issueLauncher(INPUT)).rejects.toBeInstanceOf(
      WalletNotConfiguredError,
    );
  });
});
