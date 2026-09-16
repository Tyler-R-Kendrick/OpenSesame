import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64url, encodeUtf8 } from "./encoding.js";
import { SiopV2Error } from "./errors.js";
import { isSiopV2Error } from "./errors.js";
import { SUPPORT_MATRIX } from "./index.js";
import {
  SUBJECT_SYNTAX_JWK_THUMBPRINT,
  ecP256JwkThumbprint,
  parsePublicEcP256Jwk,
} from "./jwk.js";
import { parseAuthorizationRequest } from "./request.js";
import { p256Pair } from "./test-keys.js";

describe("SUPPORT_MATRIX", () => {
  it("pins SIOPv2 Implementer's Draft 1", () => {
    expect(SUPPORT_MATRIX.specification.status).toBe("Implementer's Draft 1");
    expect(SUPPORT_MATRIX.specification.draft).toBe(
      "openid-connect-self-issued-v2-1_0-07",
    );
    expect(SUPPORT_MATRIX.specification.published).toBe("2022-01-28");
    expect(SUPPORT_MATRIX.specification.url).toBe(
      "https://openid.net/specs/openid-connect-self-issued-v2-1_0-ID1.html",
    );
    expect(SUPPORT_MATRIX.role).toBe("Self-Issued OP + RP verifier utilities");
    expect(SUPPORT_MATRIX.subjectSyntaxTypes).toEqual([
      SUBJECT_SYNTAX_JWK_THUMBPRINT,
    ]);
    expect(SUPPORT_MATRIX.signatureAlgorithms).toEqual(["ES256"]);
    expect(SUPPORT_MATRIX.implemented.length).toBeGreaterThan(0);
    expect(SUPPORT_MATRIX.notSupported.length).toBeGreaterThan(0);
    for (const entry of SUPPORT_MATRIX.notSupported) {
      expect(entry.feature.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("exports draft static Self-Issued OP metadata without claiming openid: PWA invocation", async () => {
    const { STATIC_SIOP_METADATA, STATIC_SELF_ISSUED_ISSUER } = await import(
      "./index.js"
    );
    expect(STATIC_SIOP_METADATA.issuer).toBe(STATIC_SELF_ISSUED_ISSUER);
    expect(STATIC_SIOP_METADATA.authorization_endpoint).toBe("openid:");
    expect(STATIC_SIOP_METADATA.response_types_supported).toEqual(["id_token"]);
    expect(STATIC_SIOP_METADATA.id_token_signing_alg_values_supported).toEqual([
      "ES256",
    ]);
    expect(
      SUPPORT_MATRIX.notSupported.some(
        (entry) =>
          entry.feature.includes("openid:") ||
          entry.feature.includes("discovery document HTTP"),
      ),
    ).toBe(true);
  });
});

describe("RFC 7638 EC P-256 thumbprint", () => {
  it("hashes canonical crv,kty,x,y JSON in lexicographic order", async () => {
    const { publicJwk } = await p256Pair();
    const canonical = `{"crv":"P-256","kty":"EC","x":"${publicJwk.x}","y":"${publicJwk.y}"}`;
    const expected = encodeBase64url(
      new Uint8Array(
        createHash("sha256").update(encodeUtf8(canonical)).digest(),
      ),
    );
    expect(await ecP256JwkThumbprint(publicJwk)).toBe(expected);
  });

  it("refuses private d, wrong kty/crv", () => {
    expect(() =>
      parsePublicEcP256Jwk({
        kty: "EC",
        crv: "P-256",
        x: "AAAA",
        y: "AAAA",
        d: "secret",
      }),
    ).toThrow(SiopV2Error);
    expect(() =>
      parsePublicEcP256Jwk({
        kty: "RSA",
        crv: "P-256",
        x: "AAAA",
        y: "AAAA",
      }),
    ).toThrow(SiopV2Error);
    expect(() =>
      parsePublicEcP256Jwk({
        kty: "EC",
        crv: "P-384",
        x: "AAAA",
        y: "AAAA",
      }),
    ).toThrow(SiopV2Error);
  });
});

describe("parseAuthorizationRequest", () => {
  it("requires client_id, redirect_uri, nonce, scope openid, response_type id_token", () => {
    const normalized = parseAuthorizationRequest({
      client_id: "https://rp.example/cb",
      redirect_uri: "https://rp.example/cb",
      nonce: "n-0S6_WzA2Mj",
      scope: "openid",
      response_type: "id_token",
    });
    expect(normalized.responseMode).toBe("fragment");
    expect(normalized.state).toBeNull();
  });

  it("refuses missing nonce and non-openid scope", () => {
    expect(() =>
      parseAuthorizationRequest({
        client_id: "https://rp.example/cb",
        redirect_uri: "https://rp.example/cb",
        scope: "openid",
        response_type: "id_token",
      }),
    ).toThrow(SiopV2Error);
    expect(() =>
      parseAuthorizationRequest({
        client_id: "https://rp.example/cb",
        redirect_uri: "https://rp.example/cb",
        nonce: "n1",
        scope: "openid profile",
        response_type: "id_token",
      }),
    ).toThrow(SiopV2Error);
  });

  it("refuses response_mode=post", () => {
    try {
      parseAuthorizationRequest({
        client_id: "https://rp.example/cb",
        redirect_uri: "https://rp.example/cb",
        nonce: "n1",
        scope: "openid",
        response_type: "id_token",
        response_mode: "post",
      });
      expect.unreachable("expected refusal");
    } catch (err) {
      expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
      if (err instanceof Error && isSiopV2Error(err)) {
        expect(err.code).toBe("not_supported");
      }
    }
  });
});
