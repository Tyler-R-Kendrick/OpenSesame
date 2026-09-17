/**
 * F05/X-05: consume settles each of the six subject kinds once.
 */

import {
  type InteractionKind,
  fixtures,
  overlapCast,
} from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { requesterRef } from "../routes/interaction-handles.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  FACTORY_DELEGATION,
  factoryInboxRef,
  factoryPlane,
  factoryPrincipal,
  factoryRaise,
  factoryWebauthnApprove,
} from "./interaction-factory-helpers.js";

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("F05/X-05 consume settles all six kinds once", () => {
  it("settles device, pairing, transaction, claim, grant_claim, authorization_request", async () => {
    const cp = factoryPlane();
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const inbox = await factoryInboxRef(cp, approver.accessToken);
    const now = cp.ctx.clock();
    const { session: claim } = fixtures.pendingClaim({
      id: "claim_factory_1",
      creatorPrincipalId: requester.principalId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    });
    const { session: grant } = fixtures.pendingClaim({
      id: "grant_factory_1",
      type: "connection",
      creatorPrincipalId: requester.principalId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    });
    await cp.ctx.repos.claimSessions.create(claim);
    await cp.ctx.repos.claimSessions.create(grant);
    await cp.ctx.repos.authorizationRequests.create({
      id: "areq_factory_1",
      principalId: approver.principalId,
      requesterRef: requesterRef(
        requester.principalId,
        cp.ctx.config.claimPepper,
      ),
      authorizationDetails: [FACTORY_DELEGATION],
      requestDigest: `sha256:${"ab".repeat(32)}`,
      bindingMessage: "Read acme/catalog",
      status: "pending",
      intervalSeconds: 5,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
      version: 1,
    });

    const kinds: ReadonlyArray<{
      kind: InteractionKind;
      subjectId: string;
    }> = [
      { kind: "device_authorization", subjectId: "dev-six-1" },
      { kind: "pairing", subjectId: "pair-six-1" },
      { kind: "transaction_authorization", subjectId: "txn-six-1" },
      { kind: "claim", subjectId: "claim_factory_1" },
      { kind: "grant_claim", subjectId: "grant_factory_1" },
      { kind: "authorization_request", subjectId: "areq_factory_1" },
    ];

    for (const { kind, subjectId } of kinds) {
      const createdRes = await factoryRaise(
        cp,
        requester,
        inbox,
        kind,
        subjectId,
      );
      expect(createdRes.status).toBe(201);
      const created = overlapCast<{ ref: string; requestDigest: string }>(
        await createdRes.json(),
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
      const spent = await cp.app.request(
        `/v1/interactions/${created.ref}/consume`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${requester.accessToken}` },
        },
      );
      expect(spent.status).toBe(200);
      const again = await cp.app.request(
        `/v1/interactions/${created.ref}/consume`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${requester.accessToken}` },
        },
      );
      expect(again.status).toBe(409);
    }

    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-six-1")?.session.state,
    ).toBe("consumed");
    expect(cp.ctx.stores.ceremonySubjects.getPairing("pair-six-1")?.state).toBe(
      "paired",
    );
    expect(
      cp.ctx.stores.ceremonySubjects.getTransaction("txn-six-1")?.state,
    ).toBe("authorized");
    expect(
      (await cp.ctx.repos.claimSessions.getById("claim_factory_1"))?.state,
    ).toBe("completed");
    expect(
      (await cp.ctx.repos.claimSessions.getById("grant_factory_1"))?.state,
    ).toBe("completed");
    expect(
      (await cp.ctx.repos.authorizationRequests.getById("areq_factory_1"))
        ?.status,
    ).toBe("approved");
    const applied = (
      await cp.ctx.repos.auditEvents.list({ limit: 500 })
    ).filter((event) => event.eventType === "interaction_subject.applied");
    expect(applied).toHaveLength(6);
    expect(
      (await cp.ctx.repos.outbox.listUnpublished()).filter((event) =>
        event.eventType.endsWith(".settle"),
      ),
    ).toHaveLength(0);
    for (const { kind, subjectId } of kinds) {
      const effect = cp.ctx.stores.hostSettlement.get(kind, subjectId);
      expect(effect?.outcome).toBe("succeeded");
      expect(effect?.eventType).toBe(`${kind}.settle`);
    }
    expect(
      cp.ctx.stores.hostSettlement.get("device_authorization", "dev-six-1")
        ?.sessionId,
    ).toBe("dev-six-1");
    expect(
      cp.ctx.stores.hostSettlement.get("grant_claim", "grant_factory_1")
        ?.grantId,
    ).toBe("grant_factory_1");
    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-six-1")?.session.id,
    ).toBe("dev-six-1");
  });

  it("consume succeeds without a Host and an unreachable Host does not un-succeed it", async () => {
    const cp = factoryPlane();
    expect(cp.ctx.config.hostApiUrl).toBe("http://127.0.0.1:8787");
    const approver = await factoryPrincipal(cp);
    const requester = await factoryPrincipal(cp);
    const created = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          cp,
          requester,
          await factoryInboxRef(cp, approver.accessToken),
          "device_authorization",
          "dev-no-host",
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
    const spent = await cp.app.request(
      `/v1/interactions/${created.ref}/consume`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${requester.accessToken}` },
      },
    );
    expect(spent.status).toBe(200);
    expect(
      cp.ctx.stores.hostSettlement.get("device_authorization", "dev-no-host")
        ?.outcome,
    ).toBe("succeeded");
    const applied = (await cp.ctx.repos.auditEvents.list({ limit: 500 })).find(
      (event) => event.eventType === "interaction_subject.applied",
    );
    expect(applied?.metadata?.execution).toBe("succeeded");
    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-no-host")?.session.state,
    ).toBe("consumed");

    const dead = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        operatorToken: "test-operator-token",
        hostApiUrl: "http://127.0.0.1:1",
      },
    });
    const deadApprover = await factoryPrincipal(dead);
    const deadRequester = await factoryPrincipal(dead);
    const deadCreated = overlapCast<{ ref: string; requestDigest: string }>(
      await (
        await factoryRaise(
          dead,
          deadRequester,
          await factoryInboxRef(dead, deadApprover.accessToken),
          "device_authorization",
          "dev-dead-host",
        )
      ).json(),
    );
    expect(
      (
        await factoryWebauthnApprove(
          dead,
          deadApprover,
          deadCreated.ref,
          deadCreated.requestDigest,
        )
      ).status,
    ).toBe(200);
    const deadSpent = await dead.app.request(
      `/v1/interactions/${deadCreated.ref}/consume`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${deadRequester.accessToken}` },
      },
    );
    expect(deadSpent.status).toBe(200);
    expect(
      dead.ctx.stores.hostSettlement.get(
        "device_authorization",
        "dev-dead-host",
      )?.outcome,
    ).toBe("succeeded");
    expect(
      dead.ctx.stores.ceremonySubjects.getDevice("dev-dead-host")?.session
        .state,
    ).toBe("consumed");
    const again = await dead.app.request(
      `/v1/interactions/${deadCreated.ref}/consume`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${deadRequester.accessToken}` },
      },
    );
    expect(again.status).toBe(409);
  });
});
