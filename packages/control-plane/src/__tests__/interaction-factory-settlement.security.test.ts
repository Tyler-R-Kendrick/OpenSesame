/**
 * T-01..T-09 against the shipped createControlPlane factory.
 */

import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  FACTORY_DELEGATION,
  factoryInboxRef,
  factoryPlane,
  factoryPrincipal,
  factoryRaise,
  factoryWebauthnApprove,
} from "./interaction-factory-helpers.js";
import {
  assertionFor,
  beginInteractionActivation,
  completeInteractionActivation,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("T-01..T-08 on createControlPlane", () => {
  it("T-01: digest-only POST /approve does not approve", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const created = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          cp,
          requester,
          await factoryInboxRef(cp, approver.accessToken),
          "transaction_authorization",
          "txn-t01",
        )
      ).json(),
    );
    await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const approved = await cp.app.request(
      `/v1/interactions/${created.ref}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestDigest: created.requestDigest }),
      },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    const viewed = overlapCast<{ status: string }>(
      await (
        await cp.app.request(`/v1/interactions/${created.ref}`, {
          headers: { authorization: `Bearer ${approver.accessToken}` },
        })
      ).json(),
    );
    expect(viewed.status).not.toBe("approved");
  });

  it("T-04: raw WebAuthn approves with mechanism webauthn, not session_reauth", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const created = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          cp,
          requester,
          await factoryInboxRef(cp, approver.accessToken),
          "device_authorization",
          "dev-t04",
        )
      ).json(),
    );
    const approved = await factoryWebauthnApprove(
      cp,
      approver,
      created.ref,
      created.requestDigest,
    );
    expect(approved.status).toBe(200);
    const events = await cp.ctx.repos.auditEvents.list({ limit: 500 });
    const row = events.find((e) => e.eventType === "interaction.approved");
    expect(row?.metadata?.mechanism).toBe("webauthn");
    expect(row?.metadata?.mechanism).not.toBe("session_reauth");
  });

  it("T-07: two consume races admit one winner", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const created = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          cp,
          requester,
          await factoryInboxRef(cp, approver.accessToken),
          "device_authorization",
          "dev-t07",
        )
      ).json(),
    );
    expect(
      (
        await factoryWebauthnApprove(
          cp,
          approver,
          created.ref,
          created.requestDigest,
        )
      ).status,
    ).toBe(200);
    const settled = await Promise.allSettled([
      cp.app.request(`/v1/interactions/${created.ref}/consume`, {
        method: "POST",
        headers: { authorization: `Bearer ${requester.accessToken}` },
      }),
      cp.app.request(`/v1/interactions/${created.ref}/consume`, {
        method: "POST",
        headers: { authorization: `Bearer ${requester.accessToken}` },
      }),
    ]);
    const statuses = settled.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.status : 0,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
  });

  it("T-08: revoke during the prompt refuses a minted activation", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const created = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          cp,
          requester,
          await factoryInboxRef(cp, approver.accessToken),
          "device_authorization",
          "dev-t08",
        )
      ).json(),
    );
    await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await enrolPasskey(cp, approver.principalId);
    const begun = await beginInteractionActivation(
      cp,
      approver.accessToken,
      created.ref,
      created.requestDigest,
    );
    expect(begun.status).toBe(201);
    expect(
      (
        await cp.app.request(`/v1/interactions/${created.ref}/revoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${approver.accessToken}` },
        })
      ).status,
    ).toBe(200);
    const completed = await completeInteractionActivation(
      cp,
      approver.accessToken,
      created.ref,
      begun.activationId,
      assertionFor(begun.challenge, credentialId),
    );
    expect(completed.status).toBeGreaterThanOrEqual(400);
    const approved = await cp.app.request(
      `/v1/interactions/${created.ref}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestDigest: created.requestDigest,
          activationId: begun.activationId,
        }),
      },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
    const viewed = overlapCast<{ status: string }>(
      await (
        await cp.app.request(`/v1/interactions/${created.ref}`, {
          headers: { authorization: `Bearer ${approver.accessToken}` },
        })
      ).json(),
    );
    expect(viewed.status).not.toBe("approved");
  });

  it("T-09: a fictitious device subject is 404 with no reserved slot", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const res = await cp.app.request("/v1/interactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `factory-t09-${Date.now()}`,
      },
      body: JSON.stringify({
        kind: "device_authorization",
        subject: {
          kind: "device_authorization",
          subjectId: "dev-does-not-exist",
        },
        approverRef: await factoryInboxRef(cp, approver.accessToken),
        authorizationDetails: [FACTORY_DELEGATION],
        ttlSeconds: 300,
      }),
    });
    expect(res.status).toBe(404);
    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-does-not-exist"),
    ).toBeUndefined();
  });
});
