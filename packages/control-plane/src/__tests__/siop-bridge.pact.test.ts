import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isString, isTypeofObject, overlapCast } from "@opensesame/os-domain";
import {
  STATIC_SELF_ISSUED_ISSUER,
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
} from "@opensesame/siop-v2";
import {
  assertExclusiveClaim,
  assertNoSecretFields,
  assertSourceOrder,
  checkThenSetAdmitsDoubleClaim,
} from "@opensesame/testing";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const siopVerifySource = readFileSync(
  join(here, "../services/siop-verify.ts"),
  "utf8",
);
const INSTRUMENTED = siopVerifySource.includes("stryMutAct_");
const describeSourceOracle = INSTRUMENTED ? describe.skip : describe;

const AUDIENCE = "https://id.example/siop-bridge";

async function es256Pair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  return { privateKey, publicJwk };
}

async function provisionalSession(
  app: ReturnType<typeof createControlPlane>["app"],
) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  const body = overlapCast(await res.json());
  if (
    !isTypeofObject(body) ||
    !("accessToken" in body) ||
    !isString(body.accessToken) ||
    !("principalId" in body) ||
    !isString(body.principalId)
  ) {
    throw new Error("unexpected provisional response");
  }
  return { accessToken: body.accessToken, principalId: body.principalId };
}

type SiopChallengeBody = {
  audience: string;
  expectedIssuer?: string;
};

type SiopLinkBody = {
  challengeId: string;
  idToken: string;
};

type SiopRouteBody = SiopChallengeBody | SiopLinkBody;

function bearerJson(token: string, body: SiopRouteBody) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

describeSourceOracle("PACT — hosted SIOP bridge fail-closed ordering", () => {
  it("refuses email join before it touches the challenge map", () => {
    assertSourceOrder(siopVerifySource, [
      "export async function linkVerifiedSiopSubject",
      "bodyOffersEmailJoin(input)",
      "takeSecurityMap",
    ]);
  });

  it("takes the challenge before verifying the ID Token", () => {
    assertSourceOrder(siopVerifySource, [
      "takeSecurityMap",
      "verifySiopIdToken",
    ]);
  });

  it("restores the challenge on principal mismatch before returning", () => {
    assertSourceOrder(siopVerifySource, [
      "challenge.principalId !== input.principalId",
      "restoreSiopLinkChallenge",
      "challenge_principal_mismatch",
    ]);
  });

  it("restores the challenge when verification throws, before returning", () => {
    assertSourceOrder(siopVerifySource, [
      "verified = await verifySiopIdToken",
      "restoreSiopLinkChallenge",
      "verification_failed",
    ]);
  });
});

describe("PACT — hosted SIOP bridge chaos", () => {
  it("exclusive claim of one challengeId yields exactly one successful link", async () => {
    const { app } = createControlPlane();
    const session = await provisionalSession(app);
    const challengeRes = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, {
        audience: AUDIENCE,
        expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
      }),
    );
    expect(challengeRes.status).toBe(201);
    const challenge = overlapCast(await challengeRes.json());
    const { privateKey, publicJwk } = await es256Pair();
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: AUDIENCE,
      nonce: challenge.nonce,
      publicJwk,
      signingKey: privateKey,
    });

    await assertExclusiveClaim(async () => {
      const res = await app.request(
        "/v1/siop/link",
        bearerJson(session.accessToken, {
          challengeId: challenge.challengeId,
          idToken,
        }),
      );
      return res.status === 201 || res.status === 200;
    });
  });
});

describe("PACT — hosted SIOP bridge wire contract", () => {
  it("success and error JSON carry no secret-shaped fields and never echo id_token", async () => {
    const { app } = createControlPlane();
    const session = await provisionalSession(app);
    const challengeRes = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, { audience: AUDIENCE }),
    );
    const challenge = overlapCast(await challengeRes.json());
    assertNoSecretFields(challenge);

    const badLink = await app.request(
      "/v1/siop/link",
      bearerJson(session.accessToken, {
        challengeId: challenge.challengeId,
        idToken: "not-a-jwt",
      }),
    );
    expect(badLink.status).toBe(401);
    const badBody = overlapCast(await badLink.json());
    assertNoSecretFields(badBody);
    expect(JSON.stringify(badBody)).not.toContain("not-a-jwt");

    const { privateKey, publicJwk } = await es256Pair();
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: AUDIENCE,
      nonce: challenge.nonce,
      publicJwk,
      signingKey: privateKey,
    });
    const goodLink = await app.request(
      "/v1/siop/link",
      bearerJson(session.accessToken, {
        challengeId: challenge.challengeId,
        idToken,
      }),
    );
    expect(goodLink.status).toBe(201);
    const goodBody = overlapCast(await goodLink.json());
    assertNoSecretFields(goodBody);
    expect(JSON.stringify(goodBody)).not.toContain(idToken);
    expect(JSON.stringify(goodBody)).not.toMatch(/"id_token"/);
  });
});

describe("PACT — hosted SIOP bridge adversarial mutant", () => {
  it("check-then-set admits double claim — take-before-verify is required", () => {
    checkThenSetAdmitsDoubleClaim();
  });
});
