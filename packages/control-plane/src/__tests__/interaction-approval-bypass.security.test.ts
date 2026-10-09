import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { totpCode } from "../routes/mfa.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

/**
 * Swarm S — adversarial regression tests for the interaction handoff
 * approval bypass (ADR 0086, findings F01/F02, threats T-01..T-03).
 *
 * Finding F01: `decideRoute("approved")` in
 * `packages/control-plane/src/routes/interaction-handoff.ts` settles a privileged
 * interaction on a *digest echo alone*. It mints an `ApprovalProof` with
 * `mechanism: "session_reauth"`, copies `assurance` off the approver's
 * principal record, and stamps `verifiedAt: now`. It never verifies an
 * interaction-scoped assertion (a transaction-bound WebAuthn activation whose
 * challenge commits to `requestDigest`). An authenticated session plus the
 * digest that was on the screen is therefore enough to approve — and then
 * spend — an operation. The sibling surface `/v1/authorization-requests/*`
 * already refuses this: it demands a transaction-bound activation before it
 * settles a write (see `approval-ceremony.test.ts`).
 *
 * Finding F02: the accepted approve body must carry no client-constructed
 * `ApprovalProof`. A caller may not name their own mechanism/assurance and
 * have it recorded as evidence — that is evidence manufacture. See the
 * companion contract test `packages/contracts/src/interactions.security.test.ts`.
 *
 * These tests encode the *secure* requirement, so they:
 *   - FAIL against the vulnerable baseline (documenting the live bypass), and
 *   - PASS once the approve path requires real interaction-scoped evidence.
 *
 * They assert the *effect* (was privileged authority minted and spendable?),
 * not a specific refusal status, so a compliant fix is free to reject the
 * bare echo outright or answer with a non-approving compatibility response —
 * either way the interaction must not end up approved or consumable.
 *
 * No `vi.mock`. Real app factory, real principals, real TOTP verifier.
 */

type Plane = ReturnType<typeof createControlPlane>;

function plane(): Plane {
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

/**
 * A privileged interaction: a payment. `transaction_authorization` is one of
 * the kinds the machine requires a digest for, so it is unambiguously an
 * operation whose approval must be bound to what executes.
 */
let seq = 0;
async function raisePrivileged(
  cp: Plane,
  requester: { accessToken: string; principalId: string },
  approverRef: string,
  overrides: JsonObject = {},
) {
  seedOwnedCeremony(
    cp,
    "transaction_authorization",
    "txn-77",
    requester.principalId,
  );
  const res = await cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `bypass-${++seq}`,
    },
    body: JSON.stringify({
      kind: "transaction_authorization",
      subject: { kind: "transaction_authorization", subjectId: "txn-77" },
      approverRef,
      authorizationDetails: [
        {
          type: "payment_initiation",
          amount: { currency: "USD", value: "143.72" },
          payee: { display_name: "AliceCo" },
        },
      ],
      ttlSeconds: 300,
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

/** The approver opens the question, moving it to `awaiting_approval`. */
async function openAsApprover(cp: Plane, ref: string, token: string) {
  const res = await cp.app.request(`/v1/interactions/${ref}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  expect(res.status).toBe(200);
  return overlapCast(await res.json());
}

async function approve(
  cp: Plane,
  ref: string,
  token: string,
  body: JsonObject,
) {
  return cp.app.request(`/v1/interactions/${ref}/approve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function statusAsApprover(cp: Plane, ref: string, token: string) {
  const res = await cp.app.request(`/v1/interactions/${ref}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status !== 200) return `http_${res.status}`;
  return overlapCast(await res.json()).status;
}

async function consume(cp: Plane, ref: string, requesterToken: string) {
  return cp.app.request(`/v1/interactions/${ref}/consume`, {
    method: "POST",
    headers: { authorization: `Bearer ${requesterToken}` },
  });
}

/**
 * Establish a generic, interaction-unbound MFA success for the approver: a
 * successful TOTP verify. Returns nothing — the point is only that a fresh
 * strong-auth event happened in this session that is not tied to any
 * interaction digest.
 */
async function passGenericTotp(cp: Plane, token: string) {
  const enrolled = await cp.app.request("/v1/mfa/totp/enroll", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(enrolled.status).toBe(200);
  const secret = overlapCast(await enrolled.json()).secret;
  const verified = await cp.app.request("/v1/mfa/totp/verify", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ code: totpCode(secret) }),
  });
  expect(verified.status).toBe(200);
  expect(overlapCast(await verified.json()).ok).toBe(true);
}

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("interaction approval bypass (F01/F02)", () => {
  it("T-01: a bare digest echo over an authenticated session does NOT approve a privileged interaction", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await raisePrivileged(
      cp,
      requester,
      await inboxRefOf(cp, approver),
    );
    await openAsApprover(cp, body.ref, approver.accessToken);

    // The whole attack: the approver's ordinary session, echoing the digest
    // that was on the screen, and nothing that proves a key was touched for
    // *this* operation.
    await approve(cp, body.ref, approver.accessToken, {
      requestDigest: body.requestDigest,
    });

    // Secure requirement: no privileged authority was minted. On the
    // vulnerable baseline the interaction is `approved` and the requester can
    // spend it — that is the F01 bypass.
    expect(await statusAsApprover(cp, body.ref, approver.accessToken)).not.toBe(
      "approved",
    );
    const spent = await consume(cp, body.ref, requester.accessToken);
    expect(spent.status).toBe(401);
    expect(overlapCast(await spent.json()).error).toBe("approval_required");
  });

  it("T-02: a client-constructed ApprovalProof cannot manufacture evidence or mint an approval", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await raisePrivileged(
      cp,
      requester,
      await inboxRefOf(cp, approver),
    );
    await openAsApprover(cp, body.ref, approver.accessToken);

    // A perfectly-formed proof: strong mechanism, phishing-resistant
    // assurance, a credential handle, bound to the right digest, stamped now.
    // Every field of it is a claim the server verified nothing about.
    await approve(cp, body.ref, approver.accessToken, {
      requestDigest: body.requestDigest,
      proof: {
        mechanism: "webauthn",
        boundDigest: body.requestDigest,
        credentialRef: "cred_attacker",
        assurance: "phishing_resistant",
        verifiedAt: new Date().toISOString(),
      },
    });

    // (a) No manufactured evidence reaches the trail. This half already holds
    // on the baseline (the accepted schema strips the proof), and it must
    // keep holding after any fix.
    const events = await cp.ctx.repos.auditEvents.list({ limit: 500 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("cred_attacker");
    expect(serialized).not.toContain("phishing_resistant");
    const approvedEvent = events.find(
      (event) => event.eventType === "interaction.approved",
    );
    expect(approvedEvent?.metadata?.mechanism).not.toBe("webauthn");
    expect(approvedEvent?.metadata?.assurance).not.toBe("phishing_resistant");

    // (b) And the unverified proof must not itself buy an approval. On the
    // baseline the interaction is approved (via a server-minted
    // `session_reauth`) and spendable — a client proof laundered into
    // authority even though its fields were dropped.
    expect(await statusAsApprover(cp, body.ref, approver.accessToken)).not.toBe(
      "approved",
    );
    const spent = await consume(cp, body.ref, requester.accessToken);
    expect(spent.status).toBe(401);
    expect(overlapCast(await spent.json()).error).toBe("approval_required");
  });

  it("T-03: a generic TOTP success cannot be redeemed as an interaction proof", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const body = await raisePrivileged(
      cp,
      requester,
      await inboxRefOf(cp, approver),
    );
    await openAsApprover(cp, body.ref, approver.accessToken);

    // A real, successful step-up — but a *generic* one, whose challenge is
    // not the interaction's `requestDigest`. It proves the approver is
    // present; it does not prove they agreed to this operation.
    await passGenericTotp(cp, approver.accessToken);

    await approve(cp, body.ref, approver.accessToken, {
      requestDigest: body.requestDigest,
    });

    // Generic success is not interaction-scoped, so it must not settle this
    // interaction. Baseline approves it anyway (the route never consulted the
    // TOTP step at all — the session was already enough), which is the same
    // F01 bypass reached from the "I did an MFA a moment ago" direction.
    expect(await statusAsApprover(cp, body.ref, approver.accessToken)).not.toBe(
      "approved",
    );
    const spent = await consume(cp, body.ref, requester.accessToken);
    expect(spent.status).toBe(401);
    expect(overlapCast(await spent.json()).error).toBe("approval_required");
  });
});
