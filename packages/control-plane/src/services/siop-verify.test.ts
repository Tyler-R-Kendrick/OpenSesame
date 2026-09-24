import {
  type JsonValue,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { parsePublicEcP256Jwk } from "@opensesame/siop-v2";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  type CreateSiopLinkChallengeInput,
  type LinkSiopInput,
  createSiopLinkChallenge,
  linkVerifiedSiopSubject,
  verifySiopIdToken,
} from "./siop-verify.js";
import {
  AUDIENCE,
  DYNAMIC_ISSUER,
  STATIC_SELF_ISSUED_ISSUER,
  es256Pair,
  guestPrincipal,
  mintToken,
} from "./siop-verify.test-helpers.js";

describe("verifySiopIdToken", () => {
  it("refuses private material in sub_jwk", async () => {
    const { privateKey, publicJwk } = await es256Pair();
    const leakedJwk = overlapCast<JsonValue>({ ...publicJwk, d: "leaked" });
    expect(() => parsePublicEcP256Jwk(leakedJwk, "sub_jwk")).toThrow();
    const token = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: "n1",
      profile: { kind: "static" },
    });
    await expect(
      verifySiopIdToken({
        idToken: token,
        expectedAudience: AUDIENCE,
        expectedNonce: "n1",
        profile: { kind: "static" },
      }),
    ).resolves.toMatchObject({ sub: expect.any(String) });
  });
});

describe("linkVerifiedSiopSubject", () => {
  it("binds a verified SIOP subject to the authenticated principal", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challengeOptions: CreateSiopLinkChallengeInput = {
      audience: AUDIENCE,
      expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
    };
    const challenge = await createSiopLinkChallenge(
      ctx,
      principalId,
      challengeOptions,
    );
    const idToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: challenge.nonce,
      profile: { kind: "static" },
    });
    const linkInput: LinkSiopInput = {
      principalId,
      challengeId: challenge.id,
      idToken,
    };
    const linked = await linkVerifiedSiopSubject(ctx, linkInput);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.identity.kind).toBe("siop");
    expect(linked.identity.metadata.jwk_thumbprint).toBe(
      linked.identity.subject,
    );
  });

  it("rejects wrong nonce, audience, issuer, and missing i_am_siop", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
      expectedIssuer: DYNAMIC_ISSUER,
      requireDynamicSiopMarker: true,
    });

    const wrongNonce = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken: await mintToken({
        privateKey,
        publicJwk,
        audience: AUDIENCE,
        nonce: "other",
        profile: { kind: "dynamic", issuer: DYNAMIC_ISSUER },
      }),
    });
    expect(wrongNonce).toMatchObject({
      ok: false,
      error: "verification_failed",
      code: "nonce_mismatch",
    });

    const wrongAudChallenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: "https://other.example/aud",
      expectedIssuer: DYNAMIC_ISSUER,
      requireDynamicSiopMarker: true,
    });
    const wrongAud = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: wrongAudChallenge.id,
      idToken: await mintToken({
        privateKey,
        publicJwk,
        audience: AUDIENCE,
        nonce: wrongAudChallenge.nonce,
        profile: { kind: "dynamic", issuer: DYNAMIC_ISSUER },
      }),
    });
    expect(wrongAud).toMatchObject({
      ok: false,
      error: "verification_failed",
      code: "audience_mismatch",
    });

    const issuerChallenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
      expectedIssuer: DYNAMIC_ISSUER,
      requireDynamicSiopMarker: true,
    });
    const wrongIssuer = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: issuerChallenge.id,
      idToken: await mintToken({
        privateKey,
        publicJwk,
        audience: AUDIENCE,
        nonce: issuerChallenge.nonce,
        profile: { kind: "static" },
      }),
    });
    expect(wrongIssuer).toMatchObject({
      ok: false,
      error: "verification_failed",
      code: "issuer_mismatch",
    });

    await expect(
      createSiopLinkChallenge(ctx, principalId, {
        audience: AUDIENCE,
        expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
        requireDynamicSiopMarker: true,
      }),
    ).rejects.toThrow(/issuer does not match the Self-Issued profile/);
  });

  it("rejects a forged signature", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const victim = await es256Pair();
    const attacker = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
      expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
    });
    const idToken = await mintToken({
      privateKey: attacker.privateKey,
      publicJwk: victim.publicJwk,
      audience: AUDIENCE,
      nonce: challenge.nonce,
      profile: { kind: "static" },
    });
    const result = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken,
    });
    expect(result).toMatchObject({
      ok: false,
      error: "verification_failed",
      code: "signature_invalid",
    });
  });

  it("refuses email join fields on the request body", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
    });
    const result = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken: "x",
      emailNormalized: "a@example.com",
    });
    expect(result).toMatchObject({ ok: false, error: "email_link_refused" });
  });

  it("refuses concurrent claim of the same siop_sub by another principal", async () => {
    const { app, ctx } = createControlPlane();
    const owner = await guestPrincipal(app);
    const intruder = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();

    const ownerChallenge = await createSiopLinkChallenge(ctx, owner, {
      audience: AUDIENCE,
    });
    const intruderChallenge = await createSiopLinkChallenge(ctx, intruder, {
      audience: AUDIENCE,
    });

    const ownerToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: ownerChallenge.nonce,
      profile: { kind: "static" },
    });
    const intruderToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: intruderChallenge.nonce,
      profile: { kind: "static" },
    });

    const [first, second] = await Promise.all([
      linkVerifiedSiopSubject(ctx, {
        principalId: owner,
        challengeId: ownerChallenge.id,
        idToken: ownerToken,
      }),
      linkVerifiedSiopSubject(ctx, {
        principalId: intruder,
        challengeId: intruderChallenge.id,
        idToken: intruderToken,
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(
      outcomes.filter((o) => !o.ok && o.error === "identity_collision"),
    ).toHaveLength(1);
  });
});
