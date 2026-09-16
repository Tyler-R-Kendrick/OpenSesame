import fc from "fast-check";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { isSiopV2Error } from "./errors.js";
import {
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
  verifySelfIssuedIdToken,
} from "./id-token.js";
import { ecP256JwkThumbprint } from "./jwk.js";
import { MAX_AUTH_REQUEST_CHARS } from "./limits.js";
import {
  RESPONSE_TYPE_ID_TOKEN,
  SCOPE_OPENID,
  parseAuthorizationRequest,
  serializeAuthorizationRequest,
} from "./request.js";

const FC = { numRuns: 75 } as const;

function validQuery(
  clientId: string,
  redirectUri: string,
  nonce: string,
  state: string | null,
): string {
  const params = new URLSearchParams();
  params.set("response_type", RESPONSE_TYPE_ID_TOKEN);
  params.set("client_id", clientId);
  params.set("redirect_uri", redirectUri);
  params.set("scope", SCOPE_OPENID);
  params.set("nonce", nonce);
  if (state !== null) params.set("state", state);
  return params.toString();
}

async function expectSiopRefusal(run: () => void): Promise<void> {
  try {
    run();
    expect.unreachable("expected SiopV2Error");
  } catch (thrown) {
    expect(thrown instanceof Error && isSiopV2Error(thrown)).toBe(true);
  }
}

describe("property — authorization request parse", () => {
  it("refuses duplicate required parameters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        async (clientId, redirectUri, nonce) => {
          const params = new URLSearchParams(
            validQuery(clientId, redirectUri, nonce, null),
          );
          params.append("nonce", "duplicate");
          await expectSiopRefusal(() => parseAuthorizationRequest(params));
        },
      ),
      FC,
    );
  });

  it("refuses oversize query strings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        async (pad) => {
          const base = validQuery(
            "client",
            "https://rp.example/cb",
            "nonce",
            null,
          );
          const oversized = `${base}&x=${"a".repeat(MAX_AUTH_REQUEST_CHARS)}${pad}`;
          await expectSiopRefusal(() => {
            parseAuthorizationRequest(oversized);
          });
        },
      ),
      FC,
    );
  });

  it("refuses non-openid scope values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 32 })
          .filter((s) => s !== SCOPE_OPENID),
        async (scope) => {
          const params = new URLSearchParams(
            validQuery("client", "https://rp.example/cb", "nonce", null),
          );
          params.set("scope", scope);
          await expectSiopRefusal(() => parseAuthorizationRequest(params));
        },
      ),
      FC,
    );
  });

  it("refuses unsupported response_type values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 32 })
          .filter((s) => s !== RESPONSE_TYPE_ID_TOKEN),
        async (responseType) => {
          const params = new URLSearchParams(
            validQuery("client", "https://rp.example/cb", "nonce", null),
          );
          params.set("response_type", responseType);
          await expectSiopRefusal(() => parseAuthorizationRequest(params));
        },
      ),
      FC,
    );
  });

  it("round-trips serialize(parse) for valid requests", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: null }),
        async (clientId, redirectUri, nonce, state) => {
          const parsed = parseAuthorizationRequest(
            validQuery(clientId, redirectUri, nonce, state),
          );
          const again = parseAuthorizationRequest(
            serializeAuthorizationRequest(parsed),
          );
          expect(again.clientId).toBe(clientId);
          expect(again.redirectUri).toBe(redirectUri);
          expect(again.nonce).toBe(nonce);
          expect(again.state).toBe(state);
        },
      ),
      FC,
    );
  });
});

describe("property — Self-Issued ID Token thumbprint binding", () => {
  it("verify sub equals ecP256JwkThumbprint for random ES256 keypairs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_700_000_000, max: 1_800_000_000 }),
        async (now) => {
          const { privateKey, publicKey } = await generateKeyPair("ES256", {
            extractable: true,
          });
          const publicJwk = await exportPublicEcP256Jwk(publicKey);
          const audience = "https://rp.example/cb";
          const nonce = "property-nonce";
          const idToken = await buildSelfIssuedIdToken({
            profile: { kind: "static" },
            audience,
            nonce,
            publicJwk,
            signingKey: privateKey,
            nowSeconds: now,
          });
          const verified = await verifySelfIssuedIdToken({
            idToken,
            expectedAudience: audience,
            expectedNonce: nonce,
            profile: { kind: "static" },
            nowSeconds: now + 5,
          });
          expect(verified.sub).toBe(await ecP256JwkThumbprint(publicJwk));
        },
      ),
      { numRuns: 50 },
    );
  });
});
