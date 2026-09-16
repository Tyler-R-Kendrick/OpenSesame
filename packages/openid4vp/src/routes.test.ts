/**
 * The two handlers, end to end (finding F08 + the mount path).
 *
 * The point of T-23: a request built with an approval binding digest, carried
 * to a wallet, answered, and delivered back through a courier, verifies — and
 * the `boundDigest` it yields is the *approval* digest, the value ADR 0086's
 * `approve()` compares against an interaction. Before F08 that value was a
 * protocol-internal digest and no presentation could ever settle an
 * interaction. The suite also holds the fail-closed courier path: an encrypted
 * delivery is refused before verification and leaves the session open.
 */

import { describe, expect, it } from "vitest";
import {
  type IssuedCredential,
  type TestKeyPair,
  createTestKeyPair,
  issueCredential,
  present,
} from "./__fixtures__/holder.js";
import { Openid4vpError } from "./errors.js";
import {
  type AuthorizationRequestInput,
  buildAuthorizationRequest,
} from "./request.js";
import {
  type VerifierRouteConfig,
  beginPresentation,
  finishPresentation,
} from "./routes.js";
import { InMemoryRequestSessionStore } from "./session.js";
import type { TrustedIssuer, VerifiedPresentation } from "./verify.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const ISSUER = "https://issuer.example/pid";
const VCT = "https://credentials.example/pid";
const CLIENT_ID = "x509_san_dns:verifier.example";
const APPROVAL = `sha256:${"c".repeat(64)}`;

function input(
  overrides: Partial<AuthorizationRequestInput> = {},
): AuthorizationRequestInput {
  return {
    clientId: CLIENT_ID,
    responseMode: "direct_post",
    responseUri: "https://verifier.example/openid4vp/response",
    dcqlQuery: {
      credentials: [{ id: "pid", format: "dc+sd-jwt", vctValues: [VCT] }],
    },
    transactionData: [
      {
        type: "payment_authorization",
        credentialIds: ["pid"],
        parameters: { amount: "42.00", currency: "EUR", payee: "Acme GmbH" },
      },
    ],
    approvalBindingDigest: APPROVAL,
    now: NOW,
    ...overrides,
  };
}

interface Wired {
  readonly config: VerifierRouteConfig;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly issuerKey: TestKeyPair;
  readonly holderKey: TestKeyPair;
}

async function wire(): Promise<Wired> {
  const issuerKey = await createTestKeyPair("ES256");
  const holderKey = await createTestKeyPair("ES256");
  const trustedIssuers: readonly TrustedIssuer[] = [
    { issuer: ISSUER, keys: [issuerKey.publicJwk] },
  ];
  const config: VerifierRouteConfig = {
    store: new InMemoryRequestSessionStore(),
    trustedIssuers,
    now: () => NOW,
  };
  return { config, trustedIssuers, issuerKey, holderKey };
}

async function issueFor(wired: Wired): Promise<IssuedCredential> {
  return await issueCredential({
    issuerKey: wired.issuerKey,
    issuer: ISSUER,
    holderPublicJwk: wired.holderKey.publicJwk,
    vct: VCT,
    selectivelyDisclosable: { given_name: "Ada" },
    issuedAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + 86_400_000),
  });
}

describe("beginPresentation", () => {
  it("stores the session and projects direct_post as parameters", async () => {
    const wired = await wire();
    const result = await beginPresentation(wired.config, input());
    expect(result.parameters).not.toBeNull();
    expect(result.digitalCredentialsRequest).toBeNull();
    expect(result.state).toBe(result.request.state);
    expect(result.digests.approval).toBe(APPROVAL);
    expect(await wired.config.store.lookup(result.state)).not.toBeNull();
  });

  it("projects dc_api as a Digital Credentials request", async () => {
    const wired = await wire();
    const result = await beginPresentation(
      wired.config,
      input({
        responseMode: "dc_api",
        clientId: undefined,
        responseUri: undefined,
        origin: "https://verifier.example",
      }),
    );
    expect(result.parameters).toBeNull();
    expect(result.digitalCredentialsRequest).not.toBeNull();
  });
});

describe("finishPresentation", () => {
  it("verifies and returns the approval digest as boundDigest (T-23)", async () => {
    const wired = await wire();
    const begun = await beginPresentation(wired.config, input());
    const credential = await issueFor(wired);
    const hashes = begun.request.transactionData.map((entry) => entry.hash);
    const presentation = await present({
      credential,
      holderKey: wired.holderKey,
      audience: begun.request.audience,
      nonce: begun.request.nonce,
      issuedAt: NOW,
      transactionDataHashes: hashes,
      transactionDataHashesAlg: "sha-256",
    });

    const verified: VerifiedPresentation = await finishPresentation(
      wired.config,
      {
        delivery: {
          responseMode: "direct_post",
          body: { vp_token: { pid: [presentation] }, state: begun.state },
        },
        expectedRequestDigest: begun.digests.protocol,
      },
    );

    // The whole reason for F08: the holder's signature settles the *approval*.
    expect(verified.boundDigest).toBe(APPROVAL);
    expect(verified.boundDigest).not.toBe(begun.digests.protocol);
    expect(verified.assurance.issuer).toBe(ISSUER);
  });

  it("fails closed on an encrypted delivery and leaves the session open", async () => {
    const wired = await wire();
    const begun = await beginPresentation(wired.config, input());
    let code: string | null = null;
    try {
      await finishPresentation(wired.config, {
        delivery: {
          responseMode: "direct_post.jwt",
          body: { response: "eyJhbGciOiJFQ0RILUVTIn0..aXY.Y2lwaGVy.dGFn" },
          state: begun.state,
        },
        expectedRequestDigest: begun.digests.protocol,
      });
    } catch (thrown) {
      if (thrown instanceof Openid4vpError) code = thrown.code;
      else throw thrown;
    }
    expect(code).toBe("response_encryption_unsupported");
    // Untouched: a refusal at the door is not a spent session.
    const record = await wired.config.store.lookup(begun.state);
    expect(record?.consumedAt ?? null).toBeNull();
  });

  it("still refuses a presentation bound to a different protocol digest", async () => {
    const wired = await wire();
    const begun = await beginPresentation(wired.config, input());
    const credential = await issueFor(wired);
    const hashes = begun.request.transactionData.map((entry) => entry.hash);
    const presentation = await present({
      credential,
      holderKey: wired.holderKey,
      audience: begun.request.audience,
      nonce: begun.request.nonce,
      issuedAt: NOW,
      transactionDataHashes: hashes,
      transactionDataHashesAlg: "sha-256",
    });
    let code: string | null = null;
    try {
      await finishPresentation(wired.config, {
        delivery: {
          responseMode: "direct_post",
          body: { vp_token: { pid: [presentation] }, state: begun.state },
        },
        expectedRequestDigest: `sha256:${"0".repeat(64)}`,
      });
    } catch (thrown) {
      if (thrown instanceof Openid4vpError) code = thrown.code;
      else throw thrown;
    }
    expect(code).toBe("digest_mismatch");
  });
});

describe("buildAuthorizationRequest wiring", () => {
  it("is what beginPresentation builds on", async () => {
    const direct = buildAuthorizationRequest(input());
    expect(direct.digests.approval).toBe(APPROVAL);
  });
});
