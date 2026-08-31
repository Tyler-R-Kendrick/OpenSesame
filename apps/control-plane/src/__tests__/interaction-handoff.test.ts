import {
  type JsonObject,
  interactionRef,
  overlapCast,
} from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";

/**
 * The cross-device interaction layer (ADR 0086).
 *
 * The tests below are organised around the three claims the design makes, not
 * around the routes: a reference authorizes nothing, a decision is bound to a
 * digest, and one approval is spent exactly once.
 */

type Plane = ReturnType<typeof createControlPlane>;

/** A plane whose clock the test drives, so expiry is exercised without waiting. */
function plane(clock?: () => Date): Plane {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    ...(clock ? { clock } : undefined),
  });
}

function movableClock(startMs = Date.parse("2026-08-31T12:00:00.000Z")) {
  let nowMs = startMs;
  return {
    clock: () => new Date(nowMs),
    advanceSeconds: (seconds: number) => {
      nowMs += seconds * 1000;
    },
  };
}

async function principal(cp: Plane) {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

/** Only its owner can obtain an inbox handle — that is what makes it an address. */
async function inboxRefOf(cp: Plane, who: { accessToken: string }) {
  const res = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${who.accessToken}` },
  });
  expect(res.status).toBe(200);
  return overlapCast<unknown, { approverRef: string }>(await res.json())
    .approverRef;
}

const DELEGATION_DETAIL = {
  type: "connection_delegation",
  actions: ["repository.read"],
  locations: ["repo:acme/catalog"],
};

let seq = 0;
async function raise(
  cp: Plane,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  return cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
      "content-type": "application/json",
      "idempotency-key": `raise-${++seq}`,
    },
    body: JSON.stringify({
      kind: "device_authorization",
      subject: { kind: "device_authorization", subjectId: "dev-session-77" },
      approverRef,
      authorizationDetails: [DELEGATION_DETAIL],
      ttlSeconds: 300,
      ...overrides,
    }),
  });
}

/** Create an interaction and return the creation body. */
async function created(
  cp: Plane,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  const res = await raise(cp, requesterToken, approverRef, overrides);
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

const asJson = (token?: string) => ({
  accept: "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : undefined),
});

function approvalBody(digest: string, digestOverride?: string) {
  // The echo, and nothing else. An earlier shape sent a whole ApprovalProof
  // here — mechanism, assurance, credential handle — and the server stored it
  // verbatim, which made this helper an exploit rather than a fixture.
  return JSON.stringify({ requestDigest: digestOverride ?? digest });
}

const post = (cp: Plane, path: string, token: string, body?: string) =>
  cp.app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body ? { body } : undefined),
  });

beforeEach(() => {
  // The short-link budget is module-global by necessity — it must outlive a
  // request — so it outlives an app instance too.
  resetInteractionLinkBudget();
});

describe("the short-link budget paces probing, not scanning", () => {
  it("does not let forged references deny a genuine one", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    // Far past both the client and the global budget. Every one of these
    // fails MAC verification, so every one is a prober.
    for (let i = 0; i < 3_500; i += 1) {
      await cp.app.request(`/i/i_ZmFrZQ.${"a".repeat(32)}${i % 10}`, {
        headers: { accept: "application/json" },
      });
    }

    // The person holding a real link is still served. If the budget were
    // shared, this would be a 429 and one attacker would have switched the
    // feature off for everybody on the instance.
    const genuine = await cp.app.request(`/i/${body.ref}`, {
      headers: { accept: "application/json" },
    });
    expect(genuine.status).toBe(200);
    const summary = await genuine.json();
    expect(summary.status).toBe("presented");
  });

  it("still paces a flood of forged references", async () => {
    const cp = plane();
    let sawRateLimit = false;
    for (let i = 0; i < 3_500 && !sawRateLimit; i += 1) {
      const res = await cp.app.request(`/i/i_ZmFrZQ.${"b".repeat(32)}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("interaction handoff", () => {
  it("contract: create, scan, read, approve, consume", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    expect(body.status).toBe("pending");
    expect(body.url).toBe(`http://127.0.0.1:8788/i/${body.ref}`);
    // Derived from the authorization details, never taken from the requester.
    expect(body.bindingMessage).toBe("repository.read on repo:acme/catalog");

    const scanned = await cp.app.request(`/i/${body.ref}`, {
      headers: asJson(),
    });
    expect(scanned.status).toBe(200);
    expect(await scanned.json()).toEqual({
      kind: "device_authorization",
      status: "presented",
      expiresAt: body.expiresAt,
      requiresApprover: true,
    });

    const detail = await cp.app.request(`/v1/interactions/${body.ref}`, {
      headers: asJson(approver.accessToken),
    });
    expect(detail.status).toBe(200);
    const opened = overlapCast(await detail.json());
    expect(opened.status).toBe("awaiting_approval");
    expect(opened.requestDigest).toBe(body.requestDigest);
    expect(opened.authorizationDetails).toEqual([DELEGATION_DETAIL]);
    // The approver acts through the interaction; the fronted row's id is not
    // theirs to learn and never travels.
    expect(JSON.stringify(opened)).not.toContain("dev-session-77");

    const approved = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest),
    );
    expect(approved.status).toBe(200);
    expect(overlapCast(await approved.json()).status).toBe("approved");

    const spent = await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );
    expect(spent.status).toBe(200);
    expect(overlapCast(await spent.json()).status).toBe("consumed");

    // A terminal interaction still resolves — that is what makes a
    // photographed QR useless rather than merely stale.
    const rescanned = await cp.app.request(`/i/${body.ref}`, {
      headers: asJson(),
    });
    expect(rescanned.status).toBe(200);
    expect(overlapCast(await rescanned.json()).status).toBe("consumed");
  });

  it("adversarial: the short link discloses nothing about the request", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const approverRef = await inboxRefOf(cp, approver);
    const body = await created(cp, requester.accessToken, approverRef);

    const res = await cp.app.request(`/i/${body.ref}`, { headers: asJson() });
    const serialized = await res.text();
    for (const secret of [
      String(body.requestDigest),
      String(body.bindingMessage),
      "repo:acme/catalog",
      "connection_delegation",
      "dev-session-77",
      approverRef,
      "req_",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(overlapCast(JSON.parse(serialized))).sort()).toEqual([
      "expiresAt",
      "kind",
      "requiresApprover",
      "status",
    ]);
  });

  it("adversarial: a forged MAC and an unknown id answer identically", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    // Flipping one character of the tag: correct shape, wrong MAC.
    const ref = String(body.ref);
    const tail = ref.at(-1) === "A" ? "B" : "A";
    const forged = `${ref.slice(0, -1)}${tail}`;
    // A reference this service really did mint, for a row that never existed.
    const orphan = interactionRef(
      "int_0000000000000000000000000",
      cp.ctx.config.claimPepper,
    );

    const forgedRes = await cp.app.request(`/i/${forged}`, {
      headers: asJson(),
    });
    const orphanRes = await cp.app.request(`/i/${orphan}`, {
      headers: asJson(),
    });
    expect(forgedRes.status).toBe(404);
    expect(orphanRes.status).toBe(404);
    // Byte-for-byte identical: distinguishing them would say which references
    // this deployment minted.
    expect(await forgedRes.text()).toBe(await orphanRes.text());
  });

  it("adversarial: an expired interaction is gone, not merely stale", async () => {
    const { clock, advanceSeconds } = movableClock();
    const cp = plane(clock);
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
      { ttlSeconds: 60 },
    );
    advanceSeconds(61);

    const scanned = await cp.app.request(`/i/${body.ref}`, {
      headers: asJson(),
    });
    expect(scanned.status).toBe(410);
    expect(await scanned.json()).toEqual({ error: "interaction_expired" });

    const approved = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest),
    );
    expect(approved.status).toBe(410);
    expect(await approved.json()).toEqual({ error: "interaction_expired" });
  });

  it("adversarial: a decision must echo the digest that was displayed", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const wrong = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest, `sha256:${"0".repeat(64)}`),
    );
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ error: "digest_mismatch" });

    // A caller may not declare how strongly they authenticated. Sending a
    // proof is accepted (the field is simply not part of the schema, so it is
    // stripped) but nothing it claims is believed: the recorded mechanism and
    // assurance are the ones the server established.
    const declared = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      JSON.stringify({
        requestDigest: body.requestDigest,
        proof: {
          mechanism: "webauthn",
          boundDigest: body.requestDigest,
          credentialRef: "cred_attacker",
          assurance: "phishing_resistant",
        },
      }),
    );
    expect(declared.status).toBe(200);

    const events = await cp.ctx.repos.auditEvents.list({ limit: 200 });
    const approved = events.find(
      (event) => event.eventType === "interaction.approved",
    );
    expect(approved?.metadata?.mechanism).toBe("session_reauth");
    expect(approved?.metadata?.assurance).not.toBe("phishing_resistant");
    expect(JSON.stringify(events)).not.toContain("cred_attacker");
  });

  it("adversarial: only the approver may read or decide", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const stranger = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    for (const token of [requester.accessToken, stranger.accessToken]) {
      const read = await cp.app.request(`/v1/interactions/${body.ref}`, {
        headers: asJson(token),
      });
      // 404, not 403: whether that reference is live is not theirs to learn.
      expect(read.status).toBe(404);
      const decided = await post(
        cp,
        `/v1/interactions/${body.ref}/approve`,
        token,
        approvalBody(body.requestDigest),
      );
      expect(decided.status).toBe(404);
      expect(await decided.json()).toEqual({ error: "interaction_not_found" });
    }

    const inbox = await cp.app.request("/v1/interactions", {
      headers: asJson(stranger.accessToken),
    });
    expect(await inbox.json()).toEqual({ interactions: [] });
  });

  it("contract: the approver's inbox lists their own questions only", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const inbox = await cp.app.request("/v1/interactions?status=pending", {
      headers: asJson(approver.accessToken),
    });
    expect(inbox.status).toBe(200);
    const listed = overlapCast(await inbox.json());
    expect(listed.interactions.map((row: JsonObject) => row.id)).toEqual([
      // The stored id, which the approver already reaches through the
      // reference; the reference itself is never listed back.
      expect.stringMatching(/^int_/),
    ]);
    expect(listed.interactions[0]?.requestDigest).toBe(body.requestDigest);
  });

  it("adversarial: one approval is spent exactly once under a real race", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );
    expect(
      (
        await post(
          cp,
          `/v1/interactions/${body.ref}/approve`,
          approver.accessToken,
          approvalBody(body.requestDigest),
        )
      ).status,
    ).toBe(200);

    const settled = await Promise.allSettled([
      post(cp, `/v1/interactions/${body.ref}/consume`, requester.accessToken),
      post(cp, `/v1/interactions/${body.ref}/consume`, requester.accessToken),
    ]);
    const statuses = settled.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.status : 0,
    );
    // The compare-and-set on the row version is what serializes them; an
    // application-level "is it still approved?" check would let both through.
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
  });

  it("adversarial: approving and consuming are not replayable", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    expect(
      (
        await post(
          cp,
          `/v1/interactions/${body.ref}/approve`,
          approver.accessToken,
          approvalBody(body.requestDigest),
        )
      ).status,
    ).toBe(200);
    const again = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "interaction_settled" });

    expect(
      (
        await post(
          cp,
          `/v1/interactions/${body.ref}/consume`,
          requester.accessToken,
        )
      ).status,
    ).toBe(200);
    const spentTwice = await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );
    expect(spentTwice.status).toBe(409);
    expect(await spentTwice.json()).toEqual({ error: "interaction_consumed" });
  });

  it("adversarial: an unapproved interaction cannot be spent", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const early = await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );
    // Not 404 — the caller is the right caller — and not a conflict either:
    // what is missing is the ceremony. An authenticated session is not an
    // approval.
    expect(early.status).toBe(401);
    expect(await early.json()).toEqual({ error: "approval_required" });
  });

  it("contract: either party may withdraw before the approval is spent", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const withdrawn = await post(
      cp,
      `/v1/interactions/${body.ref}/revoke`,
      requester.accessToken,
    );
    expect(withdrawn.status).toBe(200);
    expect(overlapCast(await withdrawn.json()).status).toBe("revoked");

    const decided = await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest),
    );
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ error: "interaction_revoked" });
  });

  it("contract: denial is recorded and leaves nothing to spend", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const denied = await post(
      cp,
      `/v1/interactions/${body.ref}/deny`,
      approver.accessToken,
      JSON.stringify({ requestDigest: body.requestDigest }),
    );
    expect(denied.status).toBe(200);
    expect(overlapCast(await denied.json()).status).toBe("denied");

    const spent = await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );
    expect(spent.status).toBe(401);
    expect(await spent.json()).toEqual({ error: "approval_required" });
  });

  it("adversarial: the requester cannot write the sentence the approver reads", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
      {
        kind: "transaction_authorization",
        subject: { kind: "transaction_authorization", subjectId: "txn-1" },
        authorizationDetails: [
          {
            type: "payment_initiation",
            amount: { currency: "USD", value: "143.72" },
            payee: { display_name: "AliceCo" },
          },
        ],
        // Ignored: a requester-written message is a message that can disagree
        // with what executes.
        bindingMessage: "Confirm your session",
      },
    );
    expect(body.bindingMessage).toBe("Pay 143.72 USD to AliceCo");
  });

  it("adversarial: card data in an authorization detail is refused, and not echoed", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const pan = "4111111111111111";

    const res = await raise(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
      {
        kind: "transaction_authorization",
        subject: { kind: "transaction_authorization", subjectId: "txn-2" },
        authorizationDetails: [
          {
            type: "payment_initiation",
            amount: { currency: "USD", value: "10.00" },
            payee: { display_name: "AliceCo" },
            // A PAN under an innocuous key: how card numbers actually reach
            // systems that never meant to hold them.
            reference: pan,
          },
        ],
      },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const serialized = await res.text();
    expect(serialized).not.toContain(pan);
    // The refusal names a path, and a path is built from keys the requester
    // chose — so the message stays in the log and the caller gets a code.
    expect(overlapCast(JSON.parse(serialized)).error).toBe("invalid_request");
  });

  it("adversarial: the envelope kind and the fronted ceremony must agree", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const res = await raise(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
      { kind: "transaction_authorization" },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "unsupported_kind" });
  });

  it("adversarial: an unverifiable approver handle is indistinguishable from an unknown one", async () => {
    const cp = plane();
    const requester = await principal(cp);
    const forged = await raise(
      cp,
      requester.accessToken,
      "inbox_aW50X25vdF9yZWFs.notarealtagnotarealtagnotarealt",
    );
    expect(forged.status).toBe(404);
    expect(await forged.json()).toEqual({ error: "interaction_not_found" });
  });

  it("adversarial: the audit trail carries digests, never the request itself", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );
    await cp.app.request(`/v1/interactions/${body.ref}`, {
      headers: asJson(approver.accessToken),
    });
    await post(
      cp,
      `/v1/interactions/${body.ref}/approve`,
      approver.accessToken,
      approvalBody(body.requestDigest),
    );
    await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );

    const events = await cp.ctx.repos.auditEvents.list({ limit: 500 });
    const interactionEvents = events.filter((event) =>
      event.eventType.startsWith("interaction."),
    );
    expect(interactionEvents.map((event) => event.eventType).sort()).toEqual([
      "interaction.approved",
      "interaction.consumed",
      "interaction.created",
    ]);
    const serialized = JSON.stringify(events);
    for (const forbidden of [
      String(body.ref),
      String(body.bindingMessage),
      "repo:acme/catalog",
      "connection_delegation",
      "dev-session-77",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // What a reviewer does get: the digest, the binding-message digest, and
    // how the approval was proven.
    const approvedEvent = interactionEvents.find(
      (event) => event.eventType === "interaction.approved",
    );
    expect(approvedEvent?.metadata).toMatchObject({
      interactionKind: "device_authorization",
      requestDigest: body.requestDigest,
      // Server-derived, both of them. The route verifies a session and says
      // so; it does not repeat a caller's claim about a key it never saw.
      mechanism: "session_reauth",
    });
    expect(approvedEvent?.metadata?.credentialRef).toBeUndefined();
    // The id of the row the interaction fronts never travels. The audit read
    // route hands a principal the metadata of their own events, so writing it
    // here would turn a reference back into that id for anyone shown one.
    expect(approvedEvent?.metadata?.subjectId).toBeUndefined();
    expect(approvedEvent?.metadata?.bindingMessageDigest).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it("contract: the short link renders a page for a browser and JSON for a client", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    const page = await cp.app.request(`/i/${body.ref}`, {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await page.text();
    expect(html).toContain("approve a device");
    // The page is a landing page, not a disclosure.
    expect(html).not.toContain("repo:acme/catalog");
    expect(html).not.toContain(body.requestDigest);
  });

  it("adversarial: scanning is idempotent and is never an approval", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await created(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver),
    );

    for (let i = 0; i < 3; i += 1) {
      const res = await cp.app.request(`/i/${body.ref}`, {
        headers: asJson(),
      });
      expect(overlapCast(await res.json()).status).toBe("presented");
    }
    const spent = await post(
      cp,
      `/v1/interactions/${body.ref}/consume`,
      requester.accessToken,
    );
    expect(spent.status).toBe(401);
  });
});
