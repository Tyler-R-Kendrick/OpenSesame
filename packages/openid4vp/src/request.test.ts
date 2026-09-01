/**
 * Request construction: the half of the proof the verifier writes.
 *
 * The digests asserted here are recomputed from `node:crypto` rather than from
 * `encoding.ts`, for the same reason the holder fixture avoids `sd-jwt.ts`: a
 * test that reuses the implementation's own hash helper cannot tell "correct"
 * from "consistently wrong".
 */

import { createHash } from "node:crypto";
import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
import { compactVerify, importJWK } from "jose";
import { describe, expect, it } from "vitest";
import { createTestKeyPair } from "./__fixtures__/holder.js";
import { Openid4vpError } from "./errors.js";
import { REQUEST_OBJECT_TYP, readSignedCompactJws } from "./jose.js";
import {
  type AuthorizationRequestInput,
  DC_API_PROTOCOL_UNSIGNED,
  REQUEST_BINDING_TRANSACTION_DATA_TYPE,
  authorizationRequestParameters,
  buildAuthorizationRequest,
  buildTransactionData,
  clientIdPrefix,
  digitalCredentialsRequest,
  signRequestObject,
  transactionDataHash,
} from "./request.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const VCT = "https://credentials.example/pid";

function directPost(
  overrides: Partial<AuthorizationRequestInput> = {},
): AuthorizationRequestInput {
  return {
    clientId: "x509_san_dns:verifier.example",
    responseMode: "direct_post",
    responseUri: "https://verifier.example/openid4vp/response",
    dcqlQuery: {
      credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
    },
    now: NOW,
    ...overrides,
  };
}

function refusalCode(build: () => void): string | null {
  try {
    build();
  } catch (thrown) {
    if (thrown instanceof Openid4vpError) return thrown.code;
    throw thrown;
  }
  return null;
}

describe("buildTransactionData", () => {
  it("encodes base64url JSON and digests the encoded string, not its bytes", () => {
    const entry = buildTransactionData({
      type: "payment_authorization",
      credentialIds: ["pid"],
      parameters: { amount: "42.00" },
    });

    const decoded: JsonValue = JSON.parse(
      Buffer.from(entry.encoded, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      amount: "42.00",
      credential_ids: ["pid"],
      transaction_data_hashes_alg: ["sha-256"],
      type: "payment_authorization",
    });

    // §B.3.3.1: "base64url decoding is not performed before hashing".
    expect(entry.hash).toBe(
      createHash("sha256")
        .update(Buffer.from(entry.encoded, "utf8"))
        .digest("base64url"),
    );
    expect(entry.hash).not.toBe(
      createHash("sha256")
        .update(Buffer.from(entry.encoded, "base64url"))
        .digest("base64url"),
    );
  });

  it("produces the same encoding regardless of parameter insertion order", () => {
    const a = buildTransactionData({
      type: "t",
      credentialIds: ["pid"],
      parameters: { alpha: 1, beta: 2 },
    });
    const b = buildTransactionData({
      type: "t",
      credentialIds: ["pid"],
      parameters: { beta: 2, alpha: 1 },
    });
    expect(a.encoded).toBe(b.encoded);
    expect(a.hash).toBe(b.hash);
  });

  it("refuses parameters that would overwrite the members the spec owns", () => {
    for (const key of [
      "type",
      "credential_ids",
      "transaction_data_hashes_alg",
    ]) {
      expect(
        refusalCode(() =>
          buildTransactionData({
            type: "t",
            credentialIds: ["pid"],
            parameters: { [key]: "hijacked" },
          }),
        ),
      ).toBe("malformed_presentation");
    }
  });

  it("digests under every offered algorithm", () => {
    const entry = buildTransactionData({
      type: "t",
      credentialIds: ["pid"],
      hashAlgorithms: ["sha-256", "sha-512"],
    });
    expect(transactionDataHash(entry.encoded, "sha-512")).toBe(
      createHash("sha512")
        .update(Buffer.from(entry.encoded, "utf8"))
        .digest("base64url"),
    );
    expect(transactionDataHash(entry.encoded, "sha-512")).not.toBe(entry.hash);
  });
});

describe("buildAuthorizationRequest", () => {
  it("mints 32 bytes of nonce entropy, fresh per request", () => {
    const nonces = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const request = buildAuthorizationRequest(directPost());
      expect(Buffer.from(request.nonce, "base64url")).toHaveLength(32);
      expect(request.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
      nonces.add(request.nonce);
    }
    expect(nonces.size).toBe(32);
  });

  it("appends a request-binding transaction-data entry carrying the digest", () => {
    const request = buildAuthorizationRequest(
      directPost({
        transactionData: [
          { type: "payment_authorization", credentialIds: ["pid"] },
        ],
      }),
    );
    expect(request.transactionData).toHaveLength(2);
    const binding = request.transactionData[1];
    if (binding === undefined) throw new Error("no binding entry");
    expect(binding.type).toBe(REQUEST_BINDING_TRANSACTION_DATA_TYPE);
    const decoded: JsonValue = JSON.parse(
      Buffer.from(binding.encoded, "base64url").toString("utf8"),
    );
    if (!isJsonObject(decoded))
      throw new Error("binding entry is not an object");
    expect(decoded.request_digest).toBe(request.requestDigest);
    expect(request.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses a caller-supplied entry that impersonates the binding type", () => {
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(
          directPost({
            transactionData: [
              {
                type: REQUEST_BINDING_TRANSACTION_DATA_TYPE,
                credentialIds: ["pid"],
                parameters: { request_digest: "sha256:00" },
              },
            ],
          }),
        ),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses transaction data referencing a credential the query never asked for", () => {
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(
          directPost({
            transactionData: [
              { type: "t", credentialIds: ["not-in-the-query"] },
            ],
          }),
        ),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses direct_post without a response_uri and dc_api without an origin", () => {
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(directPost({ responseUri: undefined })),
      ),
    ).toBe("malformed_presentation");
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(
          directPost({
            responseMode: "dc_api",
            clientId: undefined,
            responseUri: undefined,
            origin: undefined,
          }),
        ),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses client identifier prefixes it cannot honour", () => {
    for (const clientId of [
      "openid_federation:https://federation.example",
      "decentralized_identifier:did:example:123",
      "verifier_attestation:verifier.example",
    ]) {
      expect(
        refusalCode(() => buildAuthorizationRequest(directPost({ clientId }))),
      ).toBe("malformed_presentation");
    }
    expect(clientIdPrefix("x509_san_dns:verifier.example")).toBe(
      "x509_san_dns",
    );
    expect(clientIdPrefix("preregistered-client")).toBeNull();
  });

  it("gives the request-binding entry the algorithms every caller entry offers", () => {
    // §B.3.3.1 gives the wallet one algorithm for the whole array and the
    // verifier requires it to be offered by every authorized entry, so a
    // binding entry hard-coded to `sha-256` makes a `sha-384` request
    // unsatisfiable — and unsatisfiable only at verification, after a human has
    // consented in their wallet.
    const request = buildAuthorizationRequest(
      directPost({
        transactionData: [
          {
            type: "payment_authorization",
            credentialIds: ["pid"],
            hashAlgorithms: ["sha-384", "sha-512"],
          },
          {
            type: "shipping_authorization",
            credentialIds: ["pid"],
            hashAlgorithms: ["sha-512", "sha-384"],
          },
        ],
      }),
    );
    const binding = request.transactionData.at(-1);
    if (binding === undefined) throw new Error("no binding entry");
    expect(binding.type).toBe(REQUEST_BINDING_TRANSACTION_DATA_TYPE);
    // Canonical order, not the caller's: two requests asking the same thing
    // must produce the same bytes on the wire.
    expect(binding.hashAlgorithms).toEqual(["sha-384", "sha-512"]);
    const decoded: JsonValue = JSON.parse(
      Buffer.from(binding.encoded, "base64url").toString("utf8"),
    );
    if (!isJsonObject(decoded)) throw new Error("not an object");
    expect(decoded.transaction_data_hashes_alg).toEqual(["sha-384", "sha-512"]);
  });

  it("keeps sha-256 for the binding entry when the caller offers nothing", () => {
    const request = buildAuthorizationRequest(directPost());
    const binding = request.transactionData.at(-1);
    if (binding === undefined) throw new Error("no binding entry");
    expect(request.transactionData).toHaveLength(1);
    expect(binding.hashAlgorithms).toEqual(["sha-256"]);
  });

  it("refuses caller entries whose offered hash algorithms have nothing in common", () => {
    // No single wallet choice satisfies both, so no binding entry could rescue
    // this request. Refused here, where nobody has been asked to approve
    // anything yet.
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(
          directPost({
            transactionData: [
              {
                type: "payment_authorization",
                credentialIds: ["pid"],
                hashAlgorithms: ["sha-384"],
              },
              {
                type: "shipping_authorization",
                credentialIds: ["pid"],
                hashAlgorithms: ["sha-512"],
              },
            ],
          }),
        ),
      ),
    ).toBe("malformed_presentation");
  });

  it("refuses a query that asks for more than one credential", () => {
    expect(
      refusalCode(() =>
        buildAuthorizationRequest(
          directPost({
            dcqlQuery: {
              credentials: [
                { id: "pid", format: "dc+sd-jwt", vctValues: [VCT] },
                { id: "mdl", format: "dc+sd-jwt", vctValues: [VCT] },
              ],
            },
          }),
        ),
      ),
    ).toBe("malformed_presentation");
  });

  it("derives the DC API audience from the origin and never sends client_id", () => {
    const request = buildAuthorizationRequest({
      responseMode: "dc_api",
      origin: "https://verifier.example",
      dcqlQuery: {
        credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
      },
      now: NOW,
    });
    expect(request.audience).toBe("origin:https://verifier.example");
    expect(request.clientId).toBeNull();

    const projected = digitalCredentialsRequest(request);
    expect(projected.protocol).toBe(DC_API_PROTOCOL_UNSIGNED);
    expect(Object.keys(projected.data).sort()).toEqual([
      "dcql_query",
      "nonce",
      "response_mode",
      "response_type",
      "transaction_data",
    ]);
    expect(projected.data.response_mode).toBe("dc_api");
    expect(projected.data.nonce).toBe(request.nonce);
  });

  it("keeps the two projections apart: DC API rejects direct_post and vice versa", () => {
    const post = buildAuthorizationRequest(directPost());
    expect(refusalCode(() => digitalCredentialsRequest(post))).toBe(
      "response_mode_mismatch",
    );
    const dcApi = buildAuthorizationRequest({
      responseMode: "dc_api",
      origin: "https://verifier.example",
      dcqlQuery: {
        credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
      },
      now: NOW,
    });
    expect(refusalCode(() => authorizationRequestParameters(dcApi))).toBe(
      "response_mode_mismatch",
    );
  });
});

describe("signRequestObject", () => {
  it("produces a JAR the wallet can verify, typed oauth-authz-req+jwt", async () => {
    const key = await createTestKeyPair("ES256");
    const request = buildAuthorizationRequest(directPost());
    const jar = await signRequestObject(request, {
      alg: key.alg,
      key: key.privateKey,
      kid: key.kid,
    });

    const checked = readSignedCompactJws(
      jar,
      [REQUEST_OBJECT_TYP],
      "jose_header",
    );
    expect(checked.alg).toBe("ES256");
    expect(checked.payload.iss).toBe(request.clientId);
    expect(checked.payload.aud).toBe("https://self-issued.me/v2");
    expect(checked.payload.nonce).toBe(request.nonce);

    const publicKey = await importJWK(key.publicJwk, "ES256");
    await expect(
      compactVerify(jar, publicKey, { algorithms: ["ES256"] }),
    ).resolves.toBeDefined();
  });

  it("refuses to sign a request under the redirect_uri prefix", async () => {
    const key = await createTestKeyPair("ES256");
    const request = buildAuthorizationRequest(
      directPost({ clientId: "redirect_uri:https://verifier.example/cb" }),
    );
    // §5.9.3: such a request "cannot be signed because there is no method for
    // the Wallet to obtain a trusted key for verification".
    await expect(
      signRequestObject(request, { alg: key.alg, key: key.privateKey }),
    ).rejects.toMatchObject({ code: "malformed_presentation" });
  });
});

describe("authorizationRequestParameters", () => {
  it("carries every parameter the wallet needs and no secrets", () => {
    const request = buildAuthorizationRequest(directPost());
    const parameters = authorizationRequestParameters(request);
    expect(parameters.response_type).toBe("vp_token");
    expect(parameters.response_mode).toBe("direct_post");
    expect(parameters.client_id).toBe(request.clientId);
    expect(parameters.response_uri).toBe(request.responseUri);
    expect(parameters.state).toBe(request.state);
    const transactionData = parameters.transaction_data;
    if (!Array.isArray(transactionData)) throw new Error("no transaction data");
    for (const entry of transactionData) {
      expect(isString(entry)).toBe(true);
    }
  });
});
