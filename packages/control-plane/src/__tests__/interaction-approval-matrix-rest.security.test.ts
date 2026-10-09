import {
  type JsonObject,
  overlapCast,
  resolveInteractionRef,
} from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { seedRaiseSubject } from "./seed-ceremony-subject.js";

type Plane = ReturnType<typeof createControlPlane>;

function plane(): Plane {
  resetInteractionLinkBudget();
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  });
}

async function principal(cp: Plane) {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast<{ accessToken: string; principalId: string }>(
    await res.json(),
  );
}

async function inboxRefOf(cp: Plane, who: { accessToken: string }) {
  const res = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  return overlapCast(await res.json()).approverRef;
}

const DELEGATION = {
  type: "connection_delegation",
  actions: ["repository.read"],
  locations: ["repo:acme/catalog"],
};

let seq = 0;
async function raise(
  cp: Plane,
  requester: { accessToken: string; principalId: string },
  approverRef: string,
  overrides: JsonObject = {},
) {
  seedRaiseSubject(cp, requester.principalId, overrides);
  return cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `matrix-rest-${++seq}`,
    },
    body: JSON.stringify({
      kind: "device_authorization",
      subject: { kind: "device_authorization", subjectId: "dev-session-77" },
      approverRef,
      authorizationDetails: [DELEGATION],
      ttlSeconds: 300,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("interaction approval matrix rest (ADR 0125)", () => {
  it("T-06: the requester cannot approve with the approver's digest", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    const approved = await cp.app.request(
      `/v1/interactions/${created.ref}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requester.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestDigest: created.requestDigest }),
      },
    );
    expect(approved.status).toBeGreaterThanOrEqual(400);
  });

  it("T-05: an activation for A cannot approve B", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const inbox = await inboxRefOf(cp, approver);
    const a = overlapCast(await (await raise(cp, requester, inbox)).json());
    const b = overlapCast(
      await (
        await raise(cp, requester, inbox, {
          subject: {
            kind: "device_authorization",
            subjectId: "dev-session-b",
          },
        })
      ).json(),
    );
    await cp.app.request(`/v1/interactions/${a.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    await cp.app.request(`/v1/interactions/${b.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await enrolPasskey(cp, approver.principalId);
    const activationId = await activateInteraction(
      cp,
      approver.accessToken,
      String(a.ref),
      String(a.requestDigest),
      credentialId,
    );
    const approved = await cp.app.request(`/v1/interactions/${b.ref}/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${approver.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestDigest: b.requestDigest,
        activationId,
      }),
    });
    expect(approved.status).toBeGreaterThanOrEqual(400);
  });

  it("T-09: another principal cannot squat a live device subject", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const owner = await principal(cp);
    const squatter = await principal(cp);
    const inbox = await inboxRefOf(cp, approver);
    expect((await raise(cp, owner, inbox)).status).toBe(201);
    const res = await raise(cp, squatter, inbox);
    expect(res.status).toBe(404);
  });

  it("T-11: GET during a live activation does not consume the proof", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await enrolPasskey(cp, approver.principalId);
    await activateInteraction(
      cp,
      approver.accessToken,
      String(created.ref),
      String(created.requestDigest),
      credentialId,
    );
    const preview = await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    expect(preview.status).toBe(200);
    const viewed = overlapCast(await preview.json());
    expect(viewed.status).not.toBe("consumed");
    expect(viewed.status).not.toBe("approved");
  });

  it("T-23: a stranger cannot deny another user's interaction", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const stranger = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    const denied = await cp.app.request(
      `/v1/interactions/${created.ref}/deny`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${stranger.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it("T-40: a session_reauth proof cannot consume a high-risk kind", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (
        await raise(cp, requester, await inboxRefOf(cp, approver), {
          kind: "transaction_authorization",
          subject: {
            kind: "transaction_authorization",
            subjectId: "txn-legacy",
          },
        })
      ).json(),
    );
    const id = resolveInteractionRef(
      String(created.ref),
      cp.ctx.config.claimPepper,
    );
    const row = await cp.ctx.repos.interactions.getById(id ?? "");
    if (!row?.approverPrincipalId) throw new Error("missing row");
    const now = cp.ctx.clock();
    await cp.ctx.repos.interactions.updateWithVersion(row.id, row.version, {
      status: "approved",
      approverPrincipalId: row.approverPrincipalId,
      approvalProof: {
        mechanism: "session_reauth",
        boundDigest: String(created.requestDigest),
        assurance: "provisional",
        verifiedAt: now,
      },
      decidedAt: now,
    });
    const spent = await cp.app.request(
      `/v1/interactions/${created.ref}/consume`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${requester.accessToken}` },
      },
    );
    expect(spent.status).toBeGreaterThanOrEqual(400);
    expect(
      cp.ctx.stores.ceremonySubjects.getTransaction("txn-legacy")?.state,
    ).toBe("pending");
  });

  it("T-42: an unknown subject kind is refused, not stub-succeeded", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const res = await cp.app.request("/v1/interactions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requester.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": `matrix-unknown-${++seq}`,
      },
      body: JSON.stringify({
        kind: "not_a_kind",
        subject: { kind: "not_a_kind", subjectId: "x" },
        approverRef: await inboxRefOf(cp, approver),
        authorizationDetails: [DELEGATION],
        ttlSeconds: 300,
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(201);
  });
});
