import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  actor,
  approve,
  begin,
  complete,
  headers,
  proveFresh,
  signedApprovalFixture,
  unapproved,
} from "./authorization-signed-outcomes.test-support.js";
import { assertionFor, enrolPasskey } from "./interaction-webauthn-fixture.js";

async function signedApprovalPositive() {
  const f = await signedApprovalFixture();
  expect(f.cp.ctx.config.allowDevDefaults).toBe(false);
  const activation = await proveFresh(f);
  await unapproved(f);
  expect(
    (await f.cp.ctx.repos.approvalActivations.getById(activation.id))?.state,
  ).toBe("activated");
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(1);
  expect((await approve(f, activation.id)).status).toBe(200);
  expect(
    (await f.cp.ctx.repos.authorizationRequests.getById(f.request.authReqId))
      ?.status,
  ).toBe("approved");
  expect(
    await f.cp.ctx.repos.approvalReceipts.getForRequest(f.request.authReqId),
  ).toMatchObject({
    authReqId: f.request.authReqId,
    decision: "approved",
    requestDigest: f.request.requestDigest,
    channelKind: "in_app",
  });
  const emitted = await f.cp.ctx.repos.outbox.listUnpublished();
  expect(
    emitted.filter((row) => row.eventType === "authority.invocation.completed"),
  ).toHaveLength(1);
  const receipt = structuredClone(
    await f.cp.ctx.repos.approvalReceipts.getForRequest(f.request.authReqId),
  );
  for (let index = 0; index < 2; index++) {
    const polled = await f.cp.app.request(
      `/v1/authorization-requests/${f.request.authReqId}/poll`,
      {
        headers: headers(f.requester),
      },
    );
    expect(polled.status).toBe(200);
    expect(overlapCast(await polled.json()).status).toBe("approved");
  }
  expect(
    await f.cp.ctx.repos.approvalReceipts.getForRequest(f.request.authReqId),
  ).toEqual(receipt);
  expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(emitted);
}
async function differentRealChallenge() {
  const f = await signedApprovalFixture();
  const first = await begin(f);
  const other = await begin(f);
  const before = structuredClone(
    await f.cp.ctx.repos.approvalActivations.getById(first.id),
  );
  const refused = await complete(
    f,
    first.id,
    assertionFor(other.challenge, f.key),
  );
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({
    error: "activation_challenge_mismatch",
  });
  expect(await f.cp.ctx.repos.approvalActivations.getById(first.id)).toEqual(
    before,
  );
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(0);
  expect(await f.cp.ctx.passkeyChallenges.peek(first.challenge)).toMatchObject({
    purpose: "transaction",
    principalId: f.approver.principalId,
  });
  await unapproved(f);
  expect(
    (await complete(f, first.id, assertionFor(first.challenge, f.key))).status,
  ).toBe(200);
  expect((await approve(f, first.id)).status).toBe(200);
}
async function anotherPrincipalsSignature() {
  const f = await signedApprovalFixture();
  const foreign = await actor(f.cp);
  const foreignKey = await enrolPasskey(f.cp, foreign.principalId);
  const activation = await begin(f);
  const refused = await complete(
    f,
    activation.id,
    assertionFor(activation.challenge, foreignKey),
  );
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({
    error: "activation_verification_failed",
  });
  expect(
    (await f.cp.ctx.repos.approvalActivations.getById(activation.id))?.state,
  ).toBe("pending");
  expect((await f.cp.ctx.passkeys.list(foreign.principalId))[0]?.counter).toBe(
    0,
  );
  await unapproved(f);
  const fresh = await proveFresh(f);
  expect((await approve(f, fresh.id)).status).toBe(200);
}
async function corruptedRealSignature() {
  const f = await signedApprovalFixture();
  const activation = await begin(f);
  const signed: JsonObject = assertionFor(activation.challenge, f.key);
  const signature = signed.signature;
  if (typeof signature !== "string")
    throw new Error("fixture signature missing");
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length === 0) throw new Error("fixture signature empty");
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  const refused = await complete(f, activation.id, {
    ...signed,
    signature: bytes.toString("base64url"),
  });
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({
    error: "activation_verification_failed",
  });
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(0);
  await unapproved(f);
  const fresh = await proveFresh(f);
  expect((await approve(f, fresh.id)).status).toBe(200);
}
async function expiredActivation() {
  const f = await signedApprovalFixture();
  const activation = await begin(f);
  const original = structuredClone(
    await f.cp.ctx.repos.approvalActivations.getById(activation.id),
  );
  f.advance(300_000);
  const refused = await complete(
    f,
    activation.id,
    assertionFor(activation.challenge, f.key),
  );
  expect(refused.status).toBe(410);
  expect(await refused.json()).toEqual({ error: "activation_expired" });
  expect(
    await f.cp.ctx.repos.approvalActivations.getById(activation.id),
  ).toEqual(original);
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(0);
  await unapproved(f);
  const stranger = await actor(f.cp);
  const hidden = await f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/receipt`,
    {
      headers: headers(stranger),
    },
  );
  expect(hidden.status).toBe(404);
}

describe("Authorization approval with real WebAuthn verification", () => {
  it(
    "verifies a real signature without settling until approval and keeps terminal polls effect-free",
    signedApprovalPositive,
  );
  it(
    "refuses a signature over another issued challenge without consuming the intended activation",
    differentRealChallenge,
  );
  it(
    "refuses another principal's genuine signature and permits a new correctly bound ceremony",
    anotherPrincipalsSignature,
  );
  it(
    "refuses a damaged real signature and permits a fresh valid ceremony",
    corruptedRealSignature,
  );
  it(
    "refuses an expired activation before credential advancement while hiding its receipt from outsiders",
    expiredActivation,
  );
});
