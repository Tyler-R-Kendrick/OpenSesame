import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import {
  ask,
  created,
  post,
  remainsPending,
} from "./authorization-hotspots.test-support.js";
import {
  actor,
  headers,
  signedApprovalFixture,
} from "./authorization-signed-outcomes.test-support.js";

const HOSTILE_DETAILS: JsonObject[] = [
  { authorizationDetails: [] },
  {
    authorizationDetails: Array.from({ length: 33 }, () => ({
      type: "connection_delegation",
    })),
  },
  {
    authorizationDetails: [
      {
        type: "connection_delegation",
        actions: Array(33).fill("repository.read"),
      },
    ],
  },
  {
    authorizationDetails: [
      { type: "connection_delegation", locations: ["r".repeat(513)] },
    ],
  },
  { bindingMessage: "x".repeat(121) },
  { ttlSeconds: 29 },
  { ttlSeconds: 3601 },
];

it.each(HOSTILE_DETAILS)(
  "bounds hostile authorization details without publishing a prompt (%j)",
  async (overrides) => {
    const f = await signedApprovalFixture();
    const before = await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
      f.approver.principalId,
    );
    const outbox = await f.cp.ctx.repos.outbox.listUnpublished();
    const rejected = await ask(f, overrides);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_request" });
    expect(
      await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
        f.approver.principalId,
      ),
    ).toEqual(before);
    expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  },
);

it.each(["not-an-inbox", "inbox_aaaaaaaa", "inbox_.aaaaaaaa", "inbox_YQ."])(
  "a malformed handle %s cannot create a prompt or reveal a principal",
  async (approverRef) => {
    const f = await signedApprovalFixture();
    const before = await f.cp.ctx.repos.outbox.listUnpublished();
    const refused = await ask(f, { approverRef });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not_found" });
    expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(before);
  },
);

it("counts repeated prompts durably while permitting effect-free retries and a later fresh window", async () => {
  const f = await signedApprovalFixture();
  for (let index = 0; index < 4; index++) {
    await created(
      await ask(f, { bindingMessage: `Distinct operation ${index}` }),
    );
  }
  const rows = await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
    f.approver.principalId,
  );
  expect(rows).toHaveLength(5);
  const outbox = await f.cp.ctx.repos.outbox.listUnpublished();
  const refused = await ask(f, { bindingMessage: "Another interruption" });
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: "prompt_rate_limited" });
  expect(
    await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
      f.approver.principalId,
    ),
  ).toEqual(rows);
  expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  const duplicate = await ask(f);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({
    authReqId: f.request.authReqId,
  });
  expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  f.advance(301000);
  await created(
    await ask(f, { bindingMessage: "A later legitimate operation" }),
  );
  expect(
    await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
      f.approver.principalId,
    ),
  ).toHaveLength(6);
});

it("bounds a prompt flood across independent authenticated requesters", async () => {
  const f = await signedApprovalFixture();
  for (let index = 0; index < 4; index++)
    await created(await ask(f, { bindingMessage: `Initial pair ${index}` }));
  for (let pair = 0; pair < 3; pair++) {
    const requester = await actor(f.cp);
    for (let index = 0; index < 5; index++) {
      await created(
        await ask(
          f,
          { bindingMessage: `Pair ${pair} request ${index}` },
          f.approver,
          requester,
        ),
      );
    }
  }
  expect(
    await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
      f.approver.principalId,
    ),
  ).toHaveLength(20);
  const newcomer = await actor(f.cp);
  const outbox = await f.cp.ctx.repos.outbox.listUnpublished();
  const refused = await ask(
    f,
    { bindingMessage: "First request from a fresh sender" },
    f.approver,
    newcomer,
  );
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: "prompt_rate_limited" });
  expect(await f.cp.ctx.repos.outbox.listUnpublished()).toEqual(outbox);
  expect(
    await f.cp.ctx.repos.authorizationRequests.listForPrincipal(
      f.approver.principalId,
    ),
  ).toHaveLength(20);
});

it.each(["missing", "expired", "exhausted"] as const)(
  "a %s comparison claim cannot settle a recovery operation or replenish its guess budget",
  async (variant) => {
    const f = await signedApprovalFixture();
    const critical = await created(
      await ask(f, {
        authorizationDetails: [
          { type: "connection_delegation", actions: ["account.recovery"] },
        ],
      }),
    );
    let value = "000000";
    if (variant !== "missing") {
      const issued = await f.cp.app.request(
        `/v1/authorization-requests/${critical.authReqId}/comparison`,
        { headers: headers(f.requester) },
      );
      expect(issued.status).toBe(200);
      const code: { value: string } = overlapCast(await issued.json());
      value = code.value === "000000" ? "111111" : "000000";
      if (variant === "expired") f.advance(300000);
      if (variant === "exhausted") {
        for (let index = 0; index < 5; index++) {
          const wrong = await post(
            f,
            "approve",
            { requestDigest: critical.requestDigest, comparisonValue: value },
            f.approver,
            critical.authReqId,
          );
          expect(wrong.status).toBe(409);
          expect(await wrong.json()).toEqual({
            error: index === 4 ? "comparison_exhausted" : "comparison_mismatch",
          });
        }
      }
    }
    const refused = await post(
      f,
      "approve",
      { requestDigest: critical.requestDigest, comparisonValue: value },
      f.approver,
      critical.authReqId,
    );
    expect(refused.status).toBe(variant === "expired" ? 410 : 409);
    expect(await refused.json()).toEqual({
      error: `comparison_${variant === "missing" ? "not_found" : variant}`,
    });
    await remainsPending(f, critical);
    if (variant === "exhausted") {
      const before = await f.cp.ctx.repos.comparisonChallenges.getForRequest(
        critical.authReqId,
      );
      const reissue = await f.cp.app.request(
        `/v1/authorization-requests/${critical.authReqId}/comparison`,
        { headers: headers(f.requester) },
      );
      expect(reissue.status).toBe(409);
      expect(await reissue.json()).toEqual({
        error: "comparison_already_issued",
      });
      expect(
        await f.cp.ctx.repos.comparisonChallenges.getForRequest(
          critical.authReqId,
        ),
      ).toEqual(before);
    }
  },
);
