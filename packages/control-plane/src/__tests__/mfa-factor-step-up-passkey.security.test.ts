import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { passkeyDigest } from "../routes/mfa-factors.js";
import { assertionFor, enrolPasskey } from "./interaction-webauthn-fixture.js";
import {
  events,
  DEV,
  NOW,
  enrolTotp,
  factorIds,
  headers,
  passkeyProof,
  pinClock,
  plainChallenge,
  refusal,
  removalChallenge,
  remove,
  signedIn,
} from "./mfa-step-up-fixture.js";

/**
 * The passkey half of the factor-removal step-up (ADR 0146): an assertion
 * counts only over a challenge minted for this principal, this purpose and
 * this factor, once, within its five minutes — and that challenge is good
 * for nothing else.
 */

pinClock();

describe("a passkey proves a removal only over its own challenge", () => {
  it("removes a factor with a passkey assertion minted for that removal", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    await enrolTotp(cp, alice.accessToken);

    const challenge = await removalChallenge(cp, alice.accessToken, "totp");
    const res = await remove(
      cp,
      alice.accessToken,
      "totp",
      passkeyProof(challenge, credential),
    );
    expect(res.status).toBe(200);
    expect(await factorIds(cp, alice.accessToken)).toEqual([
      `pk_${passkeyDigest(credential)}`,
    ]);
    const [removed] = (await events(cp, alice.principalId)).filter(
      (event) => event.outcome === "succeeded",
    );
    expect(removed?.metadata).toMatchObject({
      kind: "totp",
      mechanism: "passkey",
    });
  });

  it("refuses an assertion made for another principal, purpose or factor, or replayed", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const mallory = await signedIn(cp);
    const aliceKey = await enrolPasskey(cp, alice.principalId);
    const aliceOther = await enrolPasskey(cp, alice.principalId);
    const malloryKey = await enrolPasskey(cp, mallory.principalId);
    const target = `pk_${passkeyDigest(aliceKey)}`;
    const other = `pk_${passkeyDigest(aliceOther)}`;

    // Mallory's own removal ceremony, her own key, presented on Alice's
    // session. (She cannot mint one for Alice's factor: that answers 404.)
    const foreign = await removalChallenge(
      cp,
      mallory.accessToken,
      `pk_${passkeyDigest(malloryKey)}`,
    );
    const attempts: JsonObject[] = [
      passkeyProof(foreign, malloryKey),
      // Alice's ceremony, signed by a key that is not Alice's.
      passkeyProof(
        await removalChallenge(cp, alice.accessToken, target),
        malloryKey,
      ),
      // A plain sign-in challenge: the wrong purpose.
      passkeyProof(await plainChallenge(cp, alice.accessToken), aliceKey),
      // A removal challenge for a different factor.
      passkeyProof(
        await removalChallenge(cp, alice.accessToken, other),
        aliceKey,
      ),
    ];
    for (const proof of attempts) {
      const res = await remove(cp, alice.accessToken, target, proof);
      expect(await refusal(res)).toEqual({
        status: 403,
        error: "step_up_failed",
      });
    }
    expect(await factorIds(cp, alice.accessToken)).toContain(target);

    // A good one works once, and only once.
    const good = passkeyProof(
      await removalChallenge(cp, alice.accessToken, other),
      aliceKey,
    );
    expect((await remove(cp, alice.accessToken, other, good)).status).toBe(200);
    const again = await remove(cp, alice.accessToken, target, good);
    expect(again.status).toBe(403);
    expect(await factorIds(cp, alice.accessToken)).toEqual([target]);
  });

  it("refuses an assertion over an expired removal challenge", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const key = `pk_${passkeyDigest(credential)}`;
    const challenge = await removalChallenge(cp, alice.accessToken, key);
    vi.setSystemTime(NOW + 6 * 60_000);
    const res = await remove(
      cp,
      alice.accessToken,
      key,
      passkeyProof(challenge, credential),
    );
    expect(res.status).toBe(403);
    expect(await factorIds(cp, alice.accessToken)).toEqual([key]);
  });

  it("never lets a removal challenge stand in for a sign-in assertion", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const key = `pk_${passkeyDigest(credential)}`;
    const challenge = await removalChallenge(cp, alice.accessToken, key);
    const signed = assertionFor(challenge, credential);
    const bytes = (value: unknown) => Buffer.from(String(value), "base64url");
    // The sign-in verifier expects an `authentication` challenge; a removal
    // challenge is a `transaction` one bound to a digest, and is refused.
    const res = await cp.ctx.hostAuthorizationPasskeys.verify({
      credentialId: credential,
      clientDataJSON: bytes(signed.clientDataJSON),
      authenticatorData: bytes(signed.authenticatorData),
      signature: bytes(signed.signature),
    });
    expect(res.ok).toBe(false);
  });

  it("issues a removal challenge only for a factor the caller holds", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const res = await cp.app.request("/v1/mfa/passkey/authentication-options", {
      method: "POST",
      headers: headers(alice.accessToken),
      body: JSON.stringify({ purpose: "factor.remove", factorId: "totp" }),
    });
    expect(res.status).toBe(404);
    const odd = await cp.app.request("/v1/mfa/passkey/authentication-options", {
      method: "POST",
      headers: headers(alice.accessToken),
      body: JSON.stringify({ purpose: "vault.open", factorId: "totp" }),
    });
    expect(odd.status).toBe(400);
  });
});
