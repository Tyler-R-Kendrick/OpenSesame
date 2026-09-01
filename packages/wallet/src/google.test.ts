import { generateKeyPairSync } from "node:crypto";
import type { BoundaryValue } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { type JWTPayload, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WALLET_ENV,
  type GoogleWalletEnabled,
  parseGoogleWalletConfig,
} from "./config.js";
import {
  type GoogleGenericObject,
  createGoogleWalletProvider,
} from "./google.js";
import { WalletPayloadRejected, assertPassPayloadSafe } from "./payload.js";
import {
  WalletInputError,
  type WalletPassIssueInput,
  WalletRequestError,
} from "./provider.js";

/**
 * A throwaway 2048-bit keypair. The whole Google adapter is exercised against
 * it: no live service account, no network, no credentials in the repository.
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ISSUER_ID = "3388000000022125777";
const SERVICE_ACCOUNT = "wallet@opensesame-test.iam.gserviceaccount.com";
const BASE_URL = "https://interactions.example.test";
const SAVE_PREFIX = "https://pay.google.com/gp/v/save/";
const REF = "i_aW50X0FiQ2RFZkdoSWpLbE1u.Op9Xq2KfLmNbRtYuWzAcDfGh";
const INTERACTION_URL = `${BASE_URL}/i/${REF}`;
const NOW = new Date("2026-08-31T12:00:00.000Z");
const EXPIRES = new Date("2026-08-31T12:10:00.000Z");

function config(): GoogleWalletEnabled {
  const parsed = parseGoogleWalletConfig({
    [GOOGLE_WALLET_ENV.issuerId]: ISSUER_ID,
    [GOOGLE_WALLET_ENV.classId]: "interaction",
    [GOOGLE_WALLET_ENV.serviceAccountEmail]: SERVICE_ACCOUNT,
    [GOOGLE_WALLET_ENV.serviceAccountKeyPem]: privateKey,
    [GOOGLE_WALLET_ENV.publicBaseUrl]: BASE_URL,
    [GOOGLE_WALLET_ENV.origins]: `${BASE_URL},https://console.example.test`,
  });
  if (!parsed.enabled) throw new Error("test configuration is not enabled");
  return parsed;
}

const BASE_INPUT: WalletPassIssueInput = {
  interactionRef: REF,
  interactionUrl: INTERACTION_URL,
  kind: "device_authorization",
  title: "Approve terminal login",
  subtitle: "workstation-14",
  expiresAt: EXPIRES,
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FetchRecorder {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

/** A `fetch` that answers from a script and records what it was asked. */
function recorder(statuses: ReadonlyArray<number>): FetchRecorder {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) {
      headers[name.toLowerCase()] = String(value);
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: String(init?.body ?? ""),
    });
    const status = statuses[calls.length - 1] ?? 200;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          expires_in: 3599,
        }),
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
  return createGoogleWalletProvider({
    config: config(),
    fetchImpl,
    now: () => NOW,
  });
}

/** Verify the save link and hand back its claim set. */
async function decodeSaveUrl(saveUrl: string) {
  expect(saveUrl.startsWith(SAVE_PREFIX)).toBe(true);
  const key = await importSPKI(publicKey, "RS256");
  const { payload, protectedHeader } = await jwtVerify(
    saveUrl.slice(SAVE_PREFIX.length),
    key,
  );
  return { payload, protectedHeader };
}

/**
 * The claim set a save link carries, named so the helper below states a
 * contract instead of taking jose's open dictionary.
 *
 * The suite signed these claims itself through `issuePass` moments earlier, so
 * their structure is the contract `buildGenericObject` established rather than
 * anything remote — which is what makes naming it honest here and nowhere a
 * real response is parsed.
 */
interface SaveLinkClaims {
  payload: { genericObjects: GoogleGenericObject[] };
}

/** The Generic objects a decoded save link carries. */
function decodedObjects(
  claims: SaveLinkClaims,
): ReadonlyArray<GoogleGenericObject> {
  return claims.payload.genericObjects;
}

/** Every field name in a decoded structure, at every depth. */
function keysOf(node: BoundaryValue): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => keysOf(child));
  if (node instanceof Object) {
    return Object.entries(node).flatMap(([key, value]) => [
      key,
      ...keysOf(value),
    ]);
  }
  return [];
}

describe("createGoogleWalletProvider — capabilities", () => {
  it("reports issue, update, and revoke, and no rotating barcode", () => {
    expect(provider(recorder([]).fetchImpl).capabilities()).toEqual({
      provider: "google",
      available: true,
      issue: true,
      update: true,
      revoke: true,
      rotatingBarcode: false,
    });
  });

  it("drops update and revoke on a runtime with no fetch", () => {
    // Issuance is pure signing, so it survives anywhere; the REST verbs need a
    // client, and saying so is the difference between an honest `false` and a
    // TypeError thrown at the moment somebody tries to revoke.
    const original = globalThis.fetch;
    Reflect.deleteProperty(globalThis, "fetch");
    try {
      const caps = createGoogleWalletProvider({
        config: config(),
        now: () => NOW,
      }).capabilities();
      expect(caps.issue).toBe(true);
      expect(caps.update).toBe(false);
      expect(caps.revoke).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("issuePass — round trip through the save link", () => {
  it("signs a Generic pass matching Google's schema", async () => {
    const artifact = await provider(recorder([]).fetchImpl).issuePass({
      ...BASE_INPUT,
      displayRows: [{ label: "Device", value: "workstation-14" }],
    });

    expect(artifact.provider).toBe("google");
    expect(artifact.passId.startsWith(`${ISSUER_ID}.`)).toBe(true);
    expect(artifact.expiresAt).toEqual(EXPIRES);

    const { payload, protectedHeader } = await decodeSaveUrl(artifact.saveUrl);
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(SERVICE_ACCOUNT);
    expect(payload.aud).toBe("google");
    expect(payload.typ).toBe("savetowallet");
    expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(payload.origins).toEqual([BASE_URL, "https://console.example.test"]);

    const objects = decodedObjects(overlapCast(payload));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toEqual({
      id: artifact.passId,
      classId: `${ISSUER_ID}.interaction`,
      state: "ACTIVE",
      cardTitle: {
        defaultValue: { language: "en-US", value: "Device approval" },
      },
      header: {
        defaultValue: { language: "en-US", value: "Approve terminal login" },
      },
      subheader: {
        defaultValue: { language: "en-US", value: "workstation-14" },
      },
      barcode: { type: "QR_CODE", value: INTERACTION_URL },
      textModulesData: [
        { id: "row_0", header: "Device", body: "workstation-14" },
      ],
      linksModuleData: {
        uris: [
          {
            id: "interaction",
            uri: INTERACTION_URL,
            description: "Open this request",
          },
        ],
      },
      validTimeInterval: {
        start: { date: NOW.toISOString() },
        end: { date: EXPIRES.toISOString() },
      },
      hexBackgroundColor: "#1f2933",
    });
  });

  it("omits subheader and textModulesData when there is nothing to say", async () => {
    const artifact = await provider(recorder([]).fetchImpl).issuePass({
      interactionRef: REF,
      interactionUrl: INTERACTION_URL,
      kind: "claim",
      title: "Claim this agent",
      expiresAt: EXPIRES,
    });
    const { payload } = await decodeSaveUrl(artifact.saveUrl);
    const objects = decodedObjects(overlapCast(payload));
    expect(objects[0]).not.toHaveProperty("subheader");
    expect(objects[0]).not.toHaveProperty("textModulesData");
    expect(objects[0]?.cardTitle).toEqual({
      defaultValue: { language: "en-US", value: "Ownership claim" },
    });
  });

  it("derives one stable pass id per interaction reference", async () => {
    const wallet = provider(recorder([]).fetchImpl);
    const first = await wallet.issuePass(BASE_INPUT);
    const second = await wallet.issuePass({
      ...BASE_INPUT,
      title: "Different",
    });
    const other = await wallet.issuePass({
      ...BASE_INPUT,
      interactionRef: `${REF}x`,
    });
    expect(second.passId).toBe(first.passId);
    expect(other.passId).not.toBe(first.passId);
    // The reference itself is not spelled out in the id it produces.
    expect(first.passId).not.toContain(REF);
  });
});

describe("issuePass — the signed claims carry no forbidden material", () => {
  it("survives its own payload gate after signing", async () => {
    const artifact = await provider(recorder([]).fetchImpl).issuePass({
      ...BASE_INPUT,
      displayRows: [
        { label: "Device", value: "workstation-14" },
        { label: "Requested", value: "12:00 UTC" },
      ],
    });
    const { payload } = await decodeSaveUrl(artifact.saveUrl);
    expect(() => assertPassPayloadSafe(overlapCast(payload))).not.toThrow();
  });

  it("names no field that appears on the shared deny-list", async () => {
    const artifact = await provider(recorder([]).fetchImpl).issuePass({
      ...BASE_INPUT,
      displayRows: [{ label: "Device", value: "workstation-14" }],
    });
    const { payload } = await decodeSaveUrl(artifact.saveUrl);
    const normalized = keysOf(overlapCast(payload)).map((key) =>
      key.toLowerCase().replace(/[^a-z0-9]/gu, ""),
    );
    expect(normalized).not.toContain("token");
    expect(normalized).not.toContain("accesstoken");
    expect(normalized).not.toContain("secret");
    expect(normalized).not.toContain("session");
    expect(normalized).not.toContain("credential");
    expect(normalized).toContain("barcode");
  });
});

describe("issuePass — forbidden material is refused, never issued", () => {
  const wallet = () => provider(recorder([]).fetchImpl);

  it("refuses a display row labelled for credential material", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        displayRows: [{ label: "Access token", value: "9f2c1a4e8b7d3f6a2c5e" }],
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses a near-miss label holding an opaque run", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        displayRows: [
          { label: "Session hint", value: "M2Y0YTk4YmMxZDdlNGYyMA" },
        ],
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses an OpenSesame claim token in a display row", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        displayRows: [{ label: "Detail", value: "osc_clm_1f3a9c2b.4d5e" }],
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses a JWT in the title", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        title:
          "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln",
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses a Bearer header pasted into the subtitle", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        subtitle: "Bearer ya29.a0AfB_byC9x1QzP",
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses a primary account number in a display row", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        displayRows: [{ label: "Paying with", value: "4111 1111 1111 1111" }],
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses an interaction URL carrying a token parameter", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        interactionUrl: `${INTERACTION_URL}?token=s3cr3t`,
      }),
    ).rejects.toBeInstanceOf(WalletPayloadRejected);
  });

  it("refuses a barcode pointing anywhere but our own origin", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        interactionUrl: "https://interactions.example.evil/i/abc",
      }),
    ).rejects.toBeInstanceOf(WalletInputError);
  });

  it("refuses a pass that has already expired", async () => {
    await expect(
      wallet().issuePass({
        ...BASE_INPUT,
        expiresAt: new Date(NOW.getTime() - 1000),
      }),
    ).rejects.toBeInstanceOf(WalletInputError);
  });

  it("refuses more display rows than Google will render", async () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      label: `Capability ${index}`,
      value: `justification ${index}`,
    }));
    await expect(
      wallet().issuePass({ ...BASE_INPUT, displayRows: rows }),
    ).rejects.toBeInstanceOf(WalletInputError);
  });

  it("refuses a save link too long to survive as a URL", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      label: `Capability ${index}`,
      value: `justification ${index} `.repeat(20),
    }));
    const attempt = wallet().issuePass({ ...BASE_INPUT, displayRows: rows });
    await expect(attempt).rejects.toBeInstanceOf(WalletInputError);
    await expect(attempt).rejects.toThrow(/save link is/u);
  });
});

describe("updatePass and revokePass — REST against a scripted fetch", () => {
  it("mints a service-account token, then PATCHes the object", async () => {
    const rec = recorder([200, 200]);
    const artifact = await provider(rec.fetchImpl).updatePass({
      ...BASE_INPUT,
      title: "Approve terminal login (retitled)",
    });

    expect(rec.calls).toHaveLength(2);
    const token = rec.calls[0];
    expect(token?.url).toBe("https://oauth2.googleapis.com/token");
    expect(token?.method).toBe("POST");
    expect(token?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(token?.body).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
    expect(token?.body).toContain("assertion=");

    const patch = rec.calls[1];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toBe(
      `https://walletobjects.googleapis.com/walletobjects/v1/genericObject/${artifact.passId}`,
    );
    expect(patch?.headers.authorization).toBe("Bearer test-access-token");
    expect(patch?.headers["content-type"]).toBe("application/json");
    expect(patch?.body).toContain('"state":"ACTIVE"');
    expect(patch?.body).toContain("Approve terminal login (retitled)");
  });

  it("reuses the access token across calls", async () => {
    const rec = recorder([200, 200, 200]);
    const wallet = provider(rec.fetchImpl);
    await wallet.updatePass?.(BASE_INPUT);
    await wallet.revokePass?.({ interactionRef: REF });
    expect(
      rec.calls.filter((call) => call.url.includes("oauth2")),
    ).toHaveLength(1);
  });

  it("revokes by expiring the object, and sends nothing else", async () => {
    const rec = recorder([200, 200]);
    await provider(rec.fetchImpl).revokePass?.({ interactionRef: REF });
    const patch = rec.calls[1];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toBe('{"state":"EXPIRED"}');
  });

  it("surfaces a 5xx as a typed error rather than succeeding quietly", async () => {
    const rec = recorder([200, 503]);
    await expect(
      provider(rec.fetchImpl).revokePass?.({ interactionRef: REF }),
    ).rejects.toMatchObject({
      name: "WalletRequestError",
      status: 503,
    });
  });

  it("surfaces a rejected service-account assertion", async () => {
    const rec = recorder([401]);
    await expect(
      provider(rec.fetchImpl).revokePass?.({ interactionRef: REF }),
    ).rejects.toBeInstanceOf(WalletRequestError);
  });

  it("distinguishes a missing object from a broken one", async () => {
    const rec = recorder([200, 404]);
    await expect(
      provider(rec.fetchImpl).revokePass?.({ interactionRef: REF }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("a Google outage", () => {
  const exploding: typeof fetch = () => {
    throw new Error("ECONNREFUSED walletobjects.googleapis.com");
  };

  it("does not make capabilities() throw", () => {
    expect(() => provider(exploding).capabilities()).not.toThrow();
    expect(provider(exploding).capabilities().available).toBe(true);
  });

  it("does not stop a pass being issued, and does not corrupt one", async () => {
    const wallet = provider(exploding);
    const artifact = await wallet.issuePass(BASE_INPUT);
    const before = { ...artifact };

    await expect(
      wallet.revokePass?.({ interactionRef: REF }),
    ).rejects.toMatchObject({ name: "WalletRequestError", status: 0 });

    expect(artifact).toEqual(before);
    const { payload } = await decodeSaveUrl(artifact.saveUrl);
    expect(payload.aud).toBe("google");
    expect(wallet.capabilities().rotatingBarcode).toBe(false);
  });
});

describe("issuePass — card data and labels through the real signing path", () => {
  /** The refusal a real `issuePass` produced, or a failure if it issued. */
  async function issueRejection(
    input: WalletPassIssueInput,
  ): Promise<WalletPayloadRejected> {
    try {
      await provider(recorder([]).fetchImpl).issuePass(input);
    } catch (error) {
      if (error instanceof WalletPayloadRejected) return error;
      throw error;
    }
    throw new Error("expected the pass to be refused, but it was issued");
  }

  it("refuses a card number that ends a sentence", async () => {
    // Issued, before the dot-adjacency skip learned the difference between a
    // full stop and a dotted resource identifier.
    const error = await issueRejection({
      ...BASE_INPUT,
      displayRows: [
        { label: "Paid with", value: "Charged to 4111111111111111." },
      ],
    });
    expect(error.rule).toBe("primary_account_number");
  });

  it("refuses a card number followed by a decimal amount", async () => {
    const error = await issueRejection({
      ...BASE_INPUT,
      displayRows: [{ label: "Paid with", value: "4111111111111111.00" }],
    });
    expect(error.rule).toBe("primary_account_number");
  });

  it("refuses a card number written with dots between its groups", async () => {
    const error = await issueRejection({
      ...BASE_INPUT,
      subtitle: "4111.1111.1111.1111",
    });
    expect(error.rule).toBe("primary_account_number");
  });

  it("refuses a Maestro card, which no Visa-and-Mastercard table knows", async () => {
    // `6759000000000000` was issued through this exact path before the network
    // table grew.
    const error = await issueRejection({
      ...BASE_INPUT,
      displayRows: [{ label: "Paid with", value: "6759000000000000" }],
    });
    expect(error.rule).toBe("primary_account_number");
  });

  it("keeps a display-row label out of the message when it is not a name", async () => {
    // A label is free-form UI text that Google stores as a field name. Printed
    // raw it forged a second log line: `… at $[0].Note: value contains a JWT`.
    const error = await issueRejection({
      ...BASE_INPUT,
      displayRows: [
        {
          label: "Note\nwallet payload rejected [ok] at $: nothing to see",
          value:
            "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln",
        },
      ],
    });
    expect(error.rule).toBe("bearer_shape");
    expect(error.message).not.toContain("\n");
    expect(error.path).not.toContain("\n");
  });

  it("still names an ordinary label, so a rejection can be located", async () => {
    const error = await issueRejection({
      ...BASE_INPUT,
      displayRows: [{ label: "Access token", value: "9f2c1a4e8b7d3f6a2c5e" }],
    });
    expect(error.message).toContain("Access token");
  });
});
