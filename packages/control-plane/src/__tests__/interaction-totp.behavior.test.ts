import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { factoryPrincipal } from "./interaction-factory-helpers.js";
import {
  approve,
  authenticatorCode,
  begin,
  ceremony,
  complete,
  enrolled,
  invalidAuthenticatorCode,
  pending,
  refusal,
  unchanged,
} from "./interaction-totp.test-support.js";
import { NOW, headers, pinClock } from "./mfa-step-up-fixture.js";

pinClock();

it("uses a real HMAC factor to approve a lower-risk ceremony and spends its actual subject once", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const activationId = await pending(f);
  const verified = await complete(f, activationId, proof.code);
  expect(verified.status).toBe(200);
  expect(await verified.json()).toMatchObject({
    activationId,
    state: "activated",
  });
  expect((await approve(f, activationId)).status).toBe(200);
  const row = await f.cp.ctx.repos.interactions.getById(f.id);
  expect(row).toMatchObject({
    status: "approved",
    approvalProof: {
      mechanism: "out_of_band",
      assurance: "mfa",
      boundDigest: f.requestDigest,
    },
  });
  expect(
    await f.cp.ctx.repos.approvalActivations.getById(activationId),
  ).toMatchObject({ state: "consumed" });
  const consume = () =>
    f.cp.app.request(`/v1/interactions/${f.ref}/consume`, {
      method: "POST",
      headers: headers(f.requester.accessToken),
    });
  expect((await consume()).status).toBe(200);
  const after = f.cp.ctx.stores.ceremonySubjects.getDevice(f.subjectId);
  expect(after?.session.state).toBe("consumed");
  await refusal(await consume(), 409, "interaction_consumed");
  expect(f.cp.ctx.stores.ceremonySubjects.getDevice(f.subjectId)).toEqual(
    after,
  );
});

it("does not reuse a code spent by the account's public TOTP verifier", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const first = await f.cp.app.request("/v1/mfa/totp/verify", {
    method: "POST",
    headers: headers(f.approver.accessToken),
    body: JSON.stringify({ code: proof.code }),
  });
  expect(first.status).toBe(200);
  const activationId = await pending(f);
  await refusal(
    await complete(f, activationId, proof.code),
    401,
    "activation_verification_failed",
  );
  await unchanged(f, activationId, { state: "pending", version: 1 });
  const steps = await f.cp.ctx.stores.totpSteps.get(f.approver.principalId);
  expect(steps).toBe(Math.floor(NOW / 30_000));
});

it("charges invalid six-digit codes and refuses a correct sixth attempt without activating", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const activationId = await pending(f);
  const wrong = invalidAuthenticatorCode(proof.secret, NOW);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await refusal(
      await complete(f, activationId, wrong),
      401,
      "activation_verification_failed",
    );
  }
  await refusal(
    await complete(f, activationId, proof.code),
    429,
    "too_many_attempts",
  );
  await unchanged(f, activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
  ).toBeUndefined();
  expect(
    await f.cp.ctx.stores.mfaFailures.get(
      `interaction-totp:${f.approver.principalId}:${activationId}`,
    ),
  ).toBe(6);
});

it("does not charge malformed codes and still accepts a correctly formatted proof", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const activationId = await pending(f);
  for (const code of ["12345", "1234567", "abcdef"]) {
    await refusal(
      await complete(f, activationId, code),
      400,
      "invalid_request",
    );
  }
  await unchanged(f, activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.mfaFailures.get(
      `interaction-totp:${f.approver.principalId}:${activationId}`,
    ),
  ).toBeUndefined();
  expect((await complete(f, activationId, proof.code)).status).toBe(200);
  expect(
    await f.cp.ctx.stores.mfaFailures.get(
      `interaction-totp:${f.approver.principalId}:${activationId}`,
    ),
  ).toBeUndefined();
});

it("requires the principal's enrolled factor without spending or rewriting the activation", async () => {
  const f = await ceremony();
  const activationId = await pending(f);
  await refusal(await complete(f, activationId, "123456"), 404, "not_enrolled");
  await unchanged(f, activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.mfaFailures.get(
      `interaction-totp:${f.approver.principalId}:${activationId}`,
    ),
  ).toBeUndefined();
  const proof = await enrolled(f);
  expect((await complete(f, activationId, proof.code)).status).toBe(200);
});

it("binds both the requester boundary and the pending activation before verifying its factor", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const activationId = await pending(f);
  const stranger = await factoryPrincipal(f.cp);
  for (const token of [f.requester.accessToken, stranger.accessToken]) {
    await refusal(
      await complete(f, activationId, proof.code, token),
      404,
      "interaction_not_found",
    );
  }
  await refusal(
    await complete(f, "apac_missing", proof.code),
    404,
    "activation_not_found",
  );
  const other = await ceremony("device_authorization", f);
  const otherActivation = await pending(other);
  await refusal(
    await complete(f, otherActivation, proof.code),
    404,
    "activation_not_found",
  );
  await unchanged(other, otherActivation, { state: "pending", version: 1 });
  await unchanged(f, activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
  ).toBeUndefined();
  expect((await complete(f, activationId, proof.code)).status).toBe(200);
  await refusal(
    await complete(f, activationId, proof.code),
    409,
    "activation_not_pending",
  );
});

it("refuses a WebAuthn activation on the TOTP endpoint without consuming its genuine challenge", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const result = await begin(f, "webauthn");
  expect(result.status).toBe(201);
  const body: { activationId: string; options: { challenge: string } } =
    overlapCast(await result.json());
  const original = await f.cp.ctx.passkeyChallenges.peek(
    body.options.challenge,
  );
  expect(original).toBeDefined();
  await refusal(
    await complete(f, body.activationId, proof.code),
    409,
    "activation_not_pending",
  );
  expect(await f.cp.ctx.passkeyChallenges.peek(body.options.challenge)).toEqual(
    original,
  );
  await unchanged(f, body.activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
  ).toBeUndefined();
});

it("refuses an expired activation without spending the current HMAC factor", async () => {
  const f = await ceremony();
  const proof = await enrolled(f);
  const activationId = await pending(f);
  vi.setSystemTime(NOW + 300_000);
  await refusal(
    await complete(f, activationId, authenticatorCode(proof.secret)),
    410,
    "activation_expired",
  );
  expect(
    await f.cp.ctx.repos.approvalActivations.getById(activationId),
  ).toMatchObject({ state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
  ).toBeUndefined();
});

it("refuses out-of-band activation and completion for a genuinely raised high-risk transaction", async () => {
  const f = await ceremony("transaction_authorization");
  const factor = await enrolled(f);
  const subject = f.cp.ctx.stores.ceremonySubjects.getTransaction(f.subjectId);
  await refusal(await begin(f), 400, "invalid_request");
  const activation = await begin(f, "webauthn");
  expect(activation.status).toBe(201);
  const body: { activationId: string; options: { challenge: string } } =
    overlapCast(await activation.json());
  const challenge = await f.cp.ctx.passkeyChallenges.peek(
    body.options.challenge,
  );
  expect(challenge).toBeDefined();
  await refusal(
    await complete(f, body.activationId, factor.code),
    400,
    "invalid_request",
  );
  expect(await f.cp.ctx.passkeyChallenges.peek(body.options.challenge)).toEqual(
    challenge,
  );
  await unchanged(f, body.activationId, { state: "pending", version: 1 });
  expect(
    await f.cp.ctx.stores.totpSteps.get(f.approver.principalId),
  ).toBeUndefined();
  const row = await f.cp.ctx.repos.interactions.getById(f.id);
  expect(row).not.toHaveProperty("approvalProof");
  expect(row?.status).not.toBe("approved");
  expect(f.cp.ctx.stores.ceremonySubjects.getTransaction(f.subjectId)).toEqual(
    subject,
  );
});
