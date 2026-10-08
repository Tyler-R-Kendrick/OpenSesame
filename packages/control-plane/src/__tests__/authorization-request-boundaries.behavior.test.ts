import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  ask,
  created,
  post,
  remainsPending,
} from "./authorization-hotspots.test-support.js";
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
import { assertionFor } from "./interaction-webauthn-fixture.js";

it.each(["account", "resource", "action"] as const)(
  "a genuine signed activation cannot authorize another %s and remains usable for its original transaction",
  async (axis) => {
    const f = await signedApprovalFixture();
    const owner = axis === "account" ? await actor(f.cp) : f.approver;
    const target = await created(
      await ask(
        f,
        {
          authorizationDetails: [
            {
              type: "connection_delegation",
              actions: [
                axis === "action" ? "repository.delete" : "repository.write",
              ],
              locations: [
                axis === "resource"
                  ? "repo:outcomes/other"
                  : "repo:outcomes/catalog",
              ],
            },
          ],
        },
        owner,
      ),
    );
    expect(target.requestDigest).not.toBe(f.request.requestDigest);
    const activation = await proveFresh(f);
    const refused = await post(
      f,
      "approve",
      {
        requestDigest: target.requestDigest,
        activationId: activation.id,
      },
      owner,
      target.authReqId,
    );
    expect(refused.status).toBe(409);
    const denial: { refusals: string[] } = overlapCast(await refused.json());
    expect(denial.refusals).toContain("activation_wrong_request");
    expect(denial.refusals).toContain("activation_transaction_mismatch");
    if (axis === "account")
      expect(denial.refusals).toContain("activation_wrong_principal");
    await remainsPending(f, target);
    await unapproved(f);
    expect(
      (await f.cp.ctx.repos.approvalActivations.getById(activation.id))?.state,
    ).toBe("activated");
    expect((await approve(f, activation.id)).status).toBe(200);
    await remainsPending(f, target);
  },
);

it.each(["activation", "activation/complete", "approve", "deny", "report"])(
  "malformed JSON at %s does not settle, publish, or mint an activation",
  async (suffix) => {
    const f = await signedApprovalFixture();
    const outbox = await f.cp.ctx.repos.outbox.listUnpublished();
    const response = await f.cp.app.request(
      `/v1/authorization-requests/${f.request.authReqId}/${suffix}`,
      { method: "POST", headers: headers(f.approver), body: "{" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    await unapproved(f);
    expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  },
);

it.each(["requirement", "comparison", "receipt", "poll", ""])(
  "an outsider cannot enumerate the owner's %s surface",
  async (suffix) => {
    const f = await signedApprovalFixture();
    const stranger = await actor(f.cp);
    const response = await f.cp.app.request(
      `/v1/authorization-requests/${f.request.authReqId}${suffix ? `/${suffix}` : ""}`,
      { headers: headers(stranger) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    await unapproved(f);
  },
);

it.each(["credentialId", "clientDataJSON", "authenticatorData", "signature"])(
  "bounds hostile %s before consuming a genuine activation or advancing its authenticator",
  async (field) => {
    const f = await signedApprovalFixture();
    const activation = await begin(f);
    const before = structuredClone(
      await f.cp.ctx.repos.approvalActivations.getById(activation.id),
    );
    const response = await complete(f, activation.id, {
      ...assertionFor(activation.challenge, f.key),
      [field]: "A".repeat(16385),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(
      await f.cp.ctx.repos.approvalActivations.getById(activation.id),
    ).toEqual(before);
    expect(
      (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
    ).toBe(0);
    await unapproved(f);
    expect(
      (
        await complete(
          f,
          activation.id,
          assertionFor(activation.challenge, f.key),
        )
      ).status,
    ).toBe(200);
    expect((await approve(f, activation.id)).status).toBe(200);
  },
);

it.each(["broken-json", "missing-challenge"])(
  "refuses %s client data without advancing the key or consuming the valid ceremony",
  async (variant) => {
    const f = await signedApprovalFixture();
    const activation = await begin(f);
    const refused = await complete(f, activation.id, {
      ...assertionFor(activation.challenge, f.key),
      clientDataJSON: Buffer.from(
        variant === "broken-json" ? "{" : "{}",
      ).toString("base64url"),
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "activation_challenge_mismatch",
    });
    expect(
      (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
    ).toBe(0);
    await unapproved(f);
    expect(
      (
        await complete(
          f,
          activation.id,
          assertionFor(activation.challenge, f.key),
        )
      ).status,
    ).toBe(200);
  },
);

it("hides a genuine activation from another owner and another request", async () => {
  const f = await signedApprovalFixture();
  const other = await created(
    await ask(f, { bindingMessage: "Another legitimate request" }),
  );
  const stranger = await actor(f.cp);
  const activation = await begin(f);
  const assertion = assertionFor(activation.challenge, f.key);
  for (const [owner, id] of [
    [stranger, f.request.authReqId],
    [f.approver, other.authReqId],
  ] as const) {
    const refused = await post(
      f,
      "activation/complete",
      { activationId: activation.id, ...assertion },
      owner,
      id,
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "activation_not_found" });
  }
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(0);
  expect((await complete(f, activation.id, assertion)).status).toBe(200);
  const replay = await complete(f, activation.id, assertion);
  expect(replay.status).toBe(409);
  expect(await replay.json()).toEqual({ error: "activation_not_pending" });
  expect((await approve(f, activation.id)).status).toBe(200);
  const repeated = await approve(f, activation.id);
  expect(repeated.status).toBe(422);
  expect(
    (await f.cp.ctx.passkeys.list(f.approver.principalId))[0]?.counter,
  ).toBe(1);
  await remainsPending(f, other);
});

it("does not mint or reissue ceremonies for a cancelled request", async () => {
  const f = await signedApprovalFixture();
  const activation = await begin(f);
  const cancelled = await post(f, "cancel", {}, f.requester);
  expect(cancelled.status).toBe(200);
  const beginAgain = await post(f, "activation", {
    decision: "approved",
    requestDigest: f.request.requestDigest,
  });
  expect(beginAgain.status).toBe(422);
  expect(await beginAgain.json()).toEqual({ error: "request_not_pending" });
  const comparison = await f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/comparison`,
    { headers: headers(f.requester) },
  );
  expect(comparison.status).toBe(409);
  expect(await comparison.json()).toEqual({ error: "request_not_pending" });
  expect(
    (await f.cp.ctx.repos.approvalActivations.getById(activation.id))?.state,
  ).toBe("pending");
});

it("returns expired polling without authorizing a lapsed request or disclosing a receipt", async () => {
  const f = await signedApprovalFixture();
  f.advance(3600000);
  const expired = await f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/poll`,
    { headers: headers(f.requester) },
  );
  expect(expired.status).toBe(410);
  expect(await expired.json()).toEqual({
    error: "expired_request",
    status: "expired",
  });
  expect(
    (await f.cp.ctx.repos.authorizationRequests.getById(f.request.authReqId))
      ?.status,
  ).toBe("expired");
  const receipt = await f.cp.app.request(
    `/v1/authorization-requests/${f.request.authReqId}/receipt`,
    { headers: headers(f.approver) },
  );
  expect(receipt.status).toBe(404);
  expect(await receipt.json()).toEqual({ error: "not_found" });
});
