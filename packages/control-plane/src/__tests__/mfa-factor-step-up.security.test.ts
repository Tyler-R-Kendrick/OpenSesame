import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { passkeyDigest } from "../routes/mfa-factors.js";
import { totpCode } from "../routes/mfa.js";
import { enrolPasskey } from "./interaction-webauthn-fixture.js";
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
 * Removing an account factor is authenticated at the account's own level
 * (NIST SP 800-63B §6.1.2.1; ADR 0146): a session alone strips nothing. The
 * delete carries a fresh proof from one of the principal's own factors, and
 * the server verifies it on that request. This suite: the rule, codes,
 * fences and the audit trail; the passkey half is
 * `mfa-factor-step-up-passkey.security.test.ts`.
 */

pinClock();

describe("DELETE /v1/mfa/factors/:id asks for a step-up", () => {
  it("refuses removal on the strength of the session alone", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    await enrolTotp(cp, alice.accessToken);
    const key = `pk_${passkeyDigest(credential)}`;

    for (const id of [key, "totp"]) {
      const res = await remove(cp, alice.accessToken, id);
      // Not a 401: Pages ends the session on a 401, and a person asked to
      // prove it is them has not been signed out.
      expect(await refusal(res)).toEqual({
        status: 403,
        error: "step_up_required",
      });
    }
    expect(await factorIds(cp, alice.accessToken)).toEqual([key, "totp"]);
  });

  it("refuses a wrong, expired or replayed authenticator code", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const one = await enrolPasskey(cp, alice.principalId);
    const two = await enrolPasskey(cp, alice.principalId);
    const secret = await enrolTotp(cp, alice.accessToken);
    const keyOne = `pk_${passkeyDigest(one)}`;
    const keyTwo = `pk_${passkeyDigest(two)}`;
    const current = totpCode(secret);
    const wrong = current === "000000" ? "111111" : "000000";
    const expired = totpCode(secret, 30, 6, NOW - 60_000);
    expect(expired).not.toBe(current);

    for (const code of [wrong, expired, "12345", "abcdef"]) {
      const res = await remove(cp, alice.accessToken, keyOne, {
        kind: "totp",
        code,
      });
      expect(res.status).toBe(
        code.length === 6 && /^\d+$/.test(code) ? 403 : 400,
      );
    }
    const ok = await remove(cp, alice.accessToken, keyOne, {
      kind: "totp",
      code: current,
    });
    expect(ok.status).toBe(200);
    // The same code, again within its thirty seconds, removes nothing more.
    const replay = await remove(cp, alice.accessToken, keyTwo, {
      kind: "totp",
      code: current,
    });
    expect(await refusal(replay)).toEqual({
      status: 403,
      error: "step_up_failed",
    });
    expect(await factorIds(cp, alice.accessToken)).toEqual([keyTwo, "totp"]);
  });

  it("refuses a code already spent on /v1/mfa/totp/verify", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const secret = await enrolTotp(cp, alice.accessToken);
    const code = totpCode(secret);
    const verified = await cp.app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: headers(alice.accessToken),
      body: JSON.stringify({ code }),
    });
    expect(verified.status).toBe(200);
    const res = await remove(cp, alice.accessToken, "totp", {
      kind: "totp",
      code,
    });
    expect(res.status).toBe(403);
    expect(await factorIds(cp, alice.accessToken)).toEqual(["totp"]);
  });

  it("removes a factor with a matching authenticator code, and audits the proof", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const secret = await enrolTotp(cp, alice.accessToken);
    const key = `pk_${passkeyDigest(credential)}`;

    const res = await remove(cp, alice.accessToken, key, {
      kind: "totp",
      code: totpCode(secret),
    });
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json())).toEqual({
      ok: true,
      id: key,
      kind: "passkey",
    });
    expect(await factorIds(cp, alice.accessToken)).toEqual(["totp"]);
    const [removed] = (await events(cp, alice.principalId)).filter(
      (event) => event.outcome === "succeeded",
    );
    expect(removed?.metadata).toEqual({
      action: "mfa.factor.remove",
      kind: "passkey",
      mechanism: "totp",
    });
  });

  it("removes the last factor when that factor proves itself", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const key = `pk_${passkeyDigest(credential)}`;
    const challenge = await removalChallenge(cp, alice.accessToken, key);
    const res = await remove(
      cp,
      alice.accessToken,
      key,
      passkeyProof(challenge, credential),
    );
    expect(res.status).toBe(200);
    expect(await factorIds(cp, alice.accessToken)).toEqual([]);

    const bob = await signedIn(cp);
    const secret = await enrolTotp(cp, bob.accessToken);
    const totp = await remove(cp, bob.accessToken, "totp", {
      kind: "totp",
      code: totpCode(secret),
    });
    expect(totp.status).toBe(200);
    expect(await factorIds(cp, bob.accessToken)).toEqual([]);
  });

  it("fences wrong proofs: codes per principal, assertions per credential", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const secret = await enrolTotp(cp, alice.accessToken);
    const key = `pk_${passkeyDigest(credential)}`;
    const current = totpCode(secret);
    const wrong = current === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const res = await remove(cp, alice.accessToken, key, {
        kind: "totp",
        code: wrong,
      });
      expect(res.status).toBe(403);
    }
    const fenced = await remove(cp, alice.accessToken, key, {
      kind: "totp",
      code: current,
    });
    expect(await refusal(fenced)).toEqual({
      status: 429,
      error: "too_many_attempts",
    });

    const forged = {
      ...passkeyProof(await plainChallenge(cp, alice.accessToken), credential),
    };
    for (let i = 0; i < 5; i += 1) {
      const res = await remove(cp, alice.accessToken, "totp", forged);
      expect(res.status).toBe(403);
    }
    const good = passkeyProof(
      await removalChallenge(cp, alice.accessToken, "totp"),
      credential,
    );
    const shut = await remove(cp, alice.accessToken, "totp", good);
    expect(shut.status).toBe(429);
    expect(await factorIds(cp, alice.accessToken)).toEqual([key, "totp"]);
  });

  it("records every refused proof as a denied removal", async () => {
    const cp = createControlPlane({ config: DEV });
    const alice = await signedIn(cp);
    const credential = await enrolPasskey(cp, alice.principalId);
    const key = `pk_${passkeyDigest(credential)}`;
    const secret = await enrolTotp(cp, alice.accessToken);
    const wrong = totpCode(secret) === "000000" ? "111111" : "000000";
    await remove(cp, alice.accessToken, key);
    await remove(cp, alice.accessToken, key, { kind: "totp", code: wrong });
    await remove(
      cp,
      alice.accessToken,
      key,
      passkeyProof(await plainChallenge(cp, alice.accessToken), credential),
    );
    const denied = (await events(cp, alice.principalId)).filter(
      (event) => event.outcome === "denied",
    );
    expect(denied.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "step_up_required" }),
        expect.objectContaining({ reason: "bad_code", mechanism: "totp" }),
        expect.objectContaining({
          reason: "challenge_mismatch",
          mechanism: "passkey",
        }),
      ]),
    );
    for (const event of denied) {
      expect(event.targetId).toBe(key);
      expect(JSON.stringify(event)).not.toContain(credential);
    }
  });
});
