import { describe, expect, it } from "vitest";
import { narrow } from "./harness.fixtures.test-support.js";
import {
  ENDPOINT,
  expectRefused,
  harness,
  makeProof,
  newSigner,
  wireOf,
} from "./harness.test-support.js";

describe("who may exchange", () => {
  it("only the client the key was issued to", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer);
    await expectRefused(
      h.exchange(parent.token, narrow(), { signer, clientId: "app-2" }),
      "invalid_grant",
      "subject.foreign_client",
    );
  });

  it("answers an unknown, an ended and a malformed key the same way", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer);
    const revoked = await h.exchange(parent.token, narrow(), { signer });
    await h.broker.revoke({ token: revoked.access_token });
    const wire = async (token: string) =>
      wireOf(h.exchange(token, narrow(), { signer }));
    const unknown = await wire(`osk_${"A".repeat(43)}`);
    const ended = await wire(revoked.access_token);
    const malformed = await wire("not-a-key");
    expect(unknown).toEqual({
      error: "invalid_grant",
      error_description: "The subject token is not valid.",
    });
    expect(ended).toEqual(unknown);
    expect(malformed).toEqual(unknown);
  });

  it("only with the proof of the key the subject token is bound to", async () => {
    const h = harness();
    const signer = await newSigner();
    const thief = await newSigner();
    const parent = await h.root(signer);
    await expectRefused(
      h.exchange(parent.token, narrow(), { signer: null }),
      "invalid_dpop_proof",
      "dpop.required",
    );
    await expectRefused(
      h.exchange(parent.token, narrow(), { signer: thief }),
      "invalid_dpop_proof",
      "dpop.key_mismatch",
    );
    const stale = await makeProof(signer, {
      htm: "POST",
      htu: ENDPOINT,
      token: parent.token,
      now: h.clock.now - 10 * 60_000,
    });
    await expectRefused(
      h.exchange(parent.token, narrow(), { proof: stale }),
      "invalid_dpop_proof",
      "dpop.iat",
    );
    const elsewhere = await makeProof(signer, {
      htm: "POST",
      htu: "https://evil.example.test/token",
      token: parent.token,
      now: h.clock.now,
    });
    await expectRefused(
      h.exchange(parent.token, narrow(), { proof: elsewhere }),
      "invalid_dpop_proof",
      "dpop.htu",
    );
    const proof = await makeProof(signer, {
      htm: "POST",
      htu: ENDPOINT,
      token: parent.token,
      now: h.clock.now,
    });
    await h.exchange(parent.token, narrow(), { proof });
    await expectRefused(
      h.exchange(parent.token, narrow(), { proof }),
      "invalid_dpop_proof",
      "dpop.replay",
    );
  });
});
