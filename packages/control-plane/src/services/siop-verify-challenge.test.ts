import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  createSiopLinkChallenge,
  linkVerifiedSiopSubject,
} from "./siop-verify.js";
import {
  AUDIENCE,
  es256Pair,
  guestPrincipal,
  mintToken,
} from "./siop-verify.test-helpers.js";

describe("linkVerifiedSiopSubject challenge lifecycle", () => {
  it("restores the challenge on failed verification so the owner can retry", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
    });
    const bad = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken: await mintToken({
        privateKey,
        publicJwk,
        audience: AUDIENCE,
        nonce: "wrong",
        profile: { kind: "static" },
      }),
    });
    expect(bad).toMatchObject({
      ok: false,
      error: "verification_failed",
      code: "nonce_mismatch",
    });
    const retry = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken: await mintToken({
        privateKey,
        publicJwk,
        audience: AUDIENCE,
        nonce: challenge.nonce,
        profile: { kind: "static" },
      }),
    });
    expect(retry.ok).toBe(true);
  });

  it("does not let another principal burn a challenge on principal mismatch", async () => {
    const { app, ctx } = createControlPlane();
    const owner = await guestPrincipal(app);
    const intruder = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, owner, {
      audience: AUDIENCE,
    });
    const idToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: challenge.nonce,
      profile: { kind: "static" },
    });

    const mismatch = await linkVerifiedSiopSubject(ctx, {
      principalId: intruder,
      challengeId: challenge.id,
      idToken,
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: "challenge_principal_mismatch",
    });

    const ownerLink = await linkVerifiedSiopSubject(ctx, {
      principalId: owner,
      challengeId: challenge.id,
      idToken,
    });
    expect(ownerLink.ok).toBe(true);
  });

  it("spends the challenge on success and refuses replay", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
    });
    const idToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: challenge.nonce,
      profile: { kind: "static" },
    });
    const first = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken,
    });
    expect(first.ok).toBe(true);
    const replay = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken,
    });
    expect(replay).toMatchObject({ ok: false, error: "challenge_not_found" });
  });

  it("refuses an expired challenge without restoring it", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const { app, ctx } = createControlPlane({
      clock: () => now,
    });
    const principalId = await guestPrincipal(app);
    const { privateKey, publicJwk } = await es256Pair();
    const challenge = await createSiopLinkChallenge(ctx, principalId, {
      audience: AUDIENCE,
    });
    now = new Date(challenge.expiresAt + 1);
    const idToken = await mintToken({
      privateKey,
      publicJwk,
      audience: AUDIENCE,
      nonce: challenge.nonce,
      profile: { kind: "static" },
      nowSeconds: Math.floor(now.getTime() / 1000) - 30,
    });
    const result = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken,
    });
    expect(result).toMatchObject({ ok: false, error: "challenge_expired" });
    const retry = await linkVerifiedSiopSubject(ctx, {
      principalId,
      challengeId: challenge.id,
      idToken,
    });
    expect(retry).toMatchObject({ ok: false, error: "challenge_not_found" });
  });

  it("refuses empty or whitespace audience at the service layer", async () => {
    const { app, ctx } = createControlPlane();
    const principalId = await guestPrincipal(app);
    await expect(
      createSiopLinkChallenge(ctx, principalId, { audience: "   " }),
    ).rejects.toThrow(/audience required/);
    await expect(
      createSiopLinkChallenge(ctx, principalId, { audience: "" }),
    ).rejects.toThrow(/audience required/);
  });
});
