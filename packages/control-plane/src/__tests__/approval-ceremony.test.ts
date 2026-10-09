import { createRepositories } from "@opensesame/database";
import {
  type AuthorizationRequest,
  type JsonObject,
  type Repositories,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * The approval ceremony (ADR 0084).
 *
 * Every test here is a replay an attacker would otherwise get for free: an
 * activation spent on the wrong request, spent twice, spent for the other
 * decision, spent after the rules tightened, or not spent at all. The
 * comparison tests are the anti-fatigue half — a code that costs nothing to
 * guess is not a code.
 */

type Plane = ReturnType<typeof createControlPlane>;

interface PlaneOptions {
  clock?: () => Date;
  repos?: Repositories;
}

function plane(options?: PlaneOptions): Plane {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    ...(options?.clock ? { clock: options.clock } : undefined),
    ...(options?.repos ? { repos: options.repos } : undefined),
  });
}

type App = Plane["app"];

async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function inboxRefOf(app: App, token: string): Promise<string> {
  const res = await app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${token}` },
  });
  return overlapCast(await res.json()).approverRef;
}

let seq = 0;
async function ask(
  app: App,
  requesterToken: string,
  approverRef: string,
  overrides: JsonObject = {},
) {
  return app.request("/v1/authorization-requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
      "content-type": "application/json",
      "idempotency-key": `ceremony-${++seq}`,
    },
    body: JSON.stringify({
      approverRef,
      bindingMessage: "Write to acme/catalog",
      // A write, so the risk classifier lands on `moderate` and the policy
      // demands a transaction-bound activation. That is the case worth
      // testing: a read needs no ceremony at all.
      authorizationDetails: [
        {
          type: "connection_delegation",
          actions: ["repository.write"],
          locations: ["repo:acme/catalog"],
        },
      ],
      ...overrides,
    }),
  });
}

const READ_ONLY_DETAILS = [
  {
    type: "connection_delegation",
    actions: ["repository.read"],
    locations: ["repo:acme/catalog"],
  },
];

/** Enrol a passkey the dev seam will accept an assertion from. */
async function enrolPasskey(app: App, token: string): Promise<string> {
  const credentialId = `cred_${Math.random().toString(36).slice(2)}`;
  const res = await app.request("/v1/mfa/passkey/register", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      credentialId,
      publicKey: Buffer.from("pk").toString("base64"),
    }),
  });
  expect(res.status).toBe(200);
  return credentialId;
}

async function beginActivation(
  app: App,
  token: string,
  authReqId: string,
  decision: "approved" | "denied",
  requestDigest: string,
) {
  return app.request(`/v1/authorization-requests/${authReqId}/activation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision, requestDigest }),
  });
}

/** The assertion a browser would produce, as the dev verifier accepts it. */
function assertionFor(challenge: string, credentialId: string): JsonObject {
  return {
    credentialId,
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: "http://127.0.0.1:8788",
      }),
    ).toString("base64"),
    authenticatorData: Buffer.from("authenticator-data").toString("base64"),
    signature: Buffer.from("signature").toString("base64"),
  };
}

async function completeActivation(
  app: App,
  token: string,
  authReqId: string,
  activationId: string,
  challenge: string,
  credentialId: string,
) {
  return app.request(
    `/v1/authorization-requests/${authReqId}/activation/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        activationId,
        ...assertionFor(challenge, credentialId),
      }),
    },
  );
}

async function settle(
  app: App,
  token: string,
  authReqId: string,
  action: "approve" | "deny",
  body: JsonObject,
) {
  return app.request(`/v1/authorization-requests/${authReqId}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Mint an activation and prove it, end to end. */
async function activate(
  app: App,
  token: string,
  authReqId: string,
  requestDigest: string,
  decision: "approved" | "denied",
  credentialId: string,
): Promise<string> {
  const begun = await beginActivation(
    app,
    token,
    authReqId,
    decision,
    requestDigest,
  );
  expect(begun.status).toBe(201);
  const body = overlapCast(await begun.json());
  const completed = await completeActivation(
    app,
    token,
    authReqId,
    body.activationId,
    body.options.challenge,
    credentialId,
  );
  expect(completed.status).toBe(200);
  return body.activationId;
}

describe("transaction-bound approval activation", () => {
  it("contract: a write needs an activation, and the activation settles it", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );

    // Without one, the decision is refused rather than quietly accepted.
    const bare = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: created.requestDigest,
      },
    );
    expect(bare.status).toBe(409);
    expect(overlapCast(await bare.json()).error).toBe("activation_not_found");

    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );
    const approved = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      { requestDigest: created.requestDigest, activationId },
    );
    expect(approved.status).toBe(200);
    expect(overlapCast(await approved.json()).status).toBe("approved");
  });

  it("adversarial: an activation for one request cannot settle another", async () => {
    // The cross-transaction replay. Without the request id inside the digest,
    // one touch of an authenticator would authorize whichever request the
    // caller named afterwards.
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const ref = await inboxRefOf(app, approver.accessToken);
    const a = overlapCast(
      await (await ask(app, requester.accessToken, ref)).json(),
    );
    const b = overlapCast(
      await (
        await ask(app, requester.accessToken, ref, {
          bindingMessage: "Write to acme/other",
        })
      ).json(),
    );

    const activationId = await activate(
      app,
      approver.accessToken,
      a.authReqId,
      a.requestDigest,
      "approved",
      credentialId,
    );
    const stolen = await settle(
      app,
      approver.accessToken,
      b.authReqId,
      "approve",
      {
        requestDigest: b.requestDigest,
        activationId,
      },
    );
    expect(stolen.status).toBe(409);
    const body = overlapCast(await stolen.json());
    expect(body.refusals).toContain("activation_wrong_request");

    // And request B is untouched.
    const read = await app.request(
      `/v1/authorization-requests/${b.authReqId}`,
      {
        headers: { authorization: `Bearer ${approver.accessToken}` },
      },
    );
    expect(overlapCast(await read.json()).status).toBe("pending");
  });

  it("adversarial: an activation minted to deny cannot be replayed to approve", async () => {
    // The decision is inside the transaction digest. Without it, the person
    // proves they are present and the server supplies the verb.
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "denied",
      credentialId,
    );
    const flipped = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      { requestDigest: created.requestDigest, activationId },
    );
    expect(flipped.status).toBe(409);
    expect(overlapCast(await flipped.json()).refusals).toContain(
      "activation_wrong_decision",
    );
  });

  it("adversarial: an activation cannot be spent twice", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const ref = await inboxRefOf(app, approver.accessToken);
    const first = overlapCast(
      await (await ask(app, requester.accessToken, ref)).json(),
    );
    const second = overlapCast(
      await (
        await ask(app, requester.accessToken, ref, {
          bindingMessage: "Write to acme/second",
        })
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      first.authReqId,
      first.requestDigest,
      "approved",
      credentialId,
    );
    expect(
      (
        await settle(app, approver.accessToken, first.authReqId, "approve", {
          requestDigest: first.requestDigest,
          activationId,
        })
      ).status,
    ).toBe(200);

    // Spent. Re-presenting it against a different request finds a consumed
    // row — the durable compare-and-set, not a process-local map.
    const reuse = await settle(
      app,
      approver.accessToken,
      second.authReqId,
      "approve",
      { requestDigest: second.requestDigest, activationId },
    );
    expect(reuse.status).toBe(409);
    expect(overlapCast(await reuse.json()).refusals).toContain(
      "activation_already_consumed",
    );
    const read = await app.request(
      `/v1/authorization-requests/${second.authReqId}`,
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(overlapCast(await read.json()).status).toBe("pending");
  });

  it("property: an activation expires, and an expired one settles nothing", async () => {
    let now = new Date("2026-08-19T12:00:00.000Z");
    const { app } = plane({ clock: () => now });
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
          { ttlSeconds: 3600 },
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );

    // The moderate policy allows 900 seconds of staleness and the mint caps
    // the activation at 300. Ten minutes on, the request is still live and
    // the activation is not — which is the case that matters: an expiring
    // request would refuse the settlement all by itself and prove nothing.
    now = new Date(now.getTime() + 600_000);
    const late = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      { requestDigest: created.requestDigest, activationId },
    );
    expect(late.status).toBe(410);
    expect(overlapCast(await late.json()).error).toBe("activation_expired");
  });

  it("adversarial: an assertion answering another challenge is refused", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const begun = overlapCast(
      await (
        await beginActivation(
          app,
          approver.accessToken,
          created.authReqId,
          "approved",
          created.requestDigest,
        )
      ).json(),
    );
    // A well-formed assertion over a challenge this activation was not minted
    // with. The stored `challengeDigest` is what refuses it, which is why the
    // check survives a second replica that never saw the challenge.
    const wrong = await completeActivation(
      app,
      approver.accessToken,
      created.authReqId,
      begun.activationId,
      "some-other-challenge",
      credentialId,
    );
    expect(wrong.status).toBe(401);
    expect(overlapCast(await wrong.json()).error).toBe(
      "activation_challenge_mismatch",
    );
  });

  it("adversarial: an activation belonging to someone else is not found", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const stranger = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );
    // 404, not 403: the id space is not enumerable, exactly as the inbox's
    // is not.
    const res = await settle(
      app,
      stranger.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: created.requestDigest,
        activationId,
      },
    );
    expect(res.status).toBe(404);
  });
});

/**
 * A repository seam that can rewrite the row under a live ceremony.
 *
 * There is no API for editing an authorization request — that is the point of
 * the digest — so the only way to test what happens when the row moves
 * between minting an activation and spending it is to move it here. No module
 * mocking: this is a `Repositories` value the app is constructed with.
 */
interface ShiftingRepos {
  repos: Repositories;
  shift: (patch: Partial<AuthorizationRequest>) => void;
}

function shiftingRepos(): ShiftingRepos {
  const base = createRepositories();
  let patch: Partial<AuthorizationRequest> | null = null;
  const repos: Repositories = {
    ...base,
    authorizationRequests: {
      ...base.authorizationRequests,
      getById: async (id) => {
        const row = await base.authorizationRequests.getById(id);
        if (!row || !patch) return row;
        return { ...row, ...patch };
      },
    },
  };
  return {
    repos,
    shift: (next) => {
      patch = next;
    },
  };
}

describe("what an activation is bound to", () => {
  it("adversarial: rewriting the request invalidates the activation", async () => {
    const { repos, shift } = shiftingRepos();
    const { app } = plane({ repos });
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );

    // The row now describes something else. Even a caller who echoes the new
    // digest — so the digest check passes — cannot spend the activation,
    // because the transaction digest commits to the request digest.
    const rewritten = "v2:".concat("f".repeat(64));
    shift({
      requestDigest: rewritten,
      authorizationDetails: [
        { type: "connection_delegation", actions: ["repository.delete"] },
      ],
    });
    const res = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: rewritten,
        activationId,
      },
    );
    expect(res.status).toBe(409);
    expect(overlapCast(await res.json()).refusals).toContain(
      "activation_transaction_mismatch",
    );
  });

  it("adversarial: tightening the policy invalidates an activation minted under the laxer one", async () => {
    // TOCTOU. The policy is resolved again at settlement and its digest is
    // inside the transaction digest, so an activation obtained under
    // yesterday's rules cannot be presented against today's.
    const { repos, shift } = shiftingRepos();
    const { app } = plane({ repos });
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );

    // Same request digest — only what the request *asks for* has been read
    // differently, moving it from `moderate` to `high`.
    shift({
      authorizationDetails: [
        { type: "connection_delegation", actions: ["repository.admin"] },
      ],
    });
    const res = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: created.requestDigest,
        activationId,
      },
    );
    expect(res.status).toBe(409);
    const body = overlapCast(await res.json());
    expect(body.refusals).toContain("activation_policy_changed");
  });
});

describe("the comparison ceremony", () => {
  /** A recovery action: `critical`, which is where comparison is demanded. */
  const CRITICAL_DETAILS = [
    { type: "connection_delegation", actions: ["account.recovery"] },
  ];

  async function criticalRequest(
    app: App,
    requesterToken: string,
    ref: string,
  ) {
    return overlapCast(
      await (
        await ask(app, requesterToken, ref, {
          authorizationDetails: CRITICAL_DETAILS,
        })
      ).json(),
    );
  }

  it("contract: the value is issued to the requester, once, and never to the approver", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await criticalRequest(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );

    // The approver cannot obtain it: the point of the ceremony is that the
    // value travels from where the request started.
    const asApprover = await app.request(
      `/v1/authorization-requests/${created.authReqId}/comparison`,
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(asApprover.status).toBe(404);

    const issued = await app.request(
      `/v1/authorization-requests/${created.authReqId}/comparison`,
      { headers: { authorization: `Bearer ${requester.accessToken}` } },
    );
    expect(issued.status).toBe(200);
    const value = overlapCast(await issued.json()).value;
    expect(value).toMatch(/^[0-9]{6}$/);

    // Re-issuing is refused rather than handing back a fresh budget.
    const again = await app.request(
      `/v1/authorization-requests/${created.authReqId}/comparison`,
      { headers: { authorization: `Bearer ${requester.accessToken}` } },
    );
    expect(again.status).toBe(409);
    expect(overlapCast(await again.json()).error).toBe(
      "comparison_already_issued",
    );
  });

  it("adversarial: a wrong value burns budget, re-issuing does not refill it, and the plaintext is nowhere", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = await criticalRequest(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const issued = overlapCast(
      await (
        await app.request(
          `/v1/authorization-requests/${created.authReqId}/comparison`,
          { headers: { authorization: `Bearer ${requester.accessToken}` } },
        )
      ).json(),
    );
    const real: string = issued.value;
    const wrong = real === "000000" ? "111111" : "000000";
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );

    const seen: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const res = await settle(
        app,
        approver.accessToken,
        created.authReqId,
        "approve",
        {
          requestDigest: created.requestDigest,
          activationId,
          comparisonValue: wrong,
        },
      );
      const body = overlapCast(await res.json());
      seen.push(body.error);
      // Re-issuing mid-grind must not refill the budget.
      await app.request(
        `/v1/authorization-requests/${created.authReqId}/comparison`,
        { headers: { authorization: `Bearer ${requester.accessToken}` } },
      );
      if (body.error === "comparison_exhausted") break;
    }
    expect(seen[0]).toBe("comparison_mismatch");
    expect(seen).toContain("comparison_exhausted");

    // The request was never settled by any of that.
    const read = await app.request(
      `/v1/authorization-requests/${created.authReqId}`,
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(overlapCast(await read.json()).status).toBe("pending");

    // And the value itself reached no audit row. A six-digit code in a trail
    // that more people can read than can approve is not a second factor.
    const events = await ctx.repos.auditEvents.list({ limit: 200 });
    expect(JSON.stringify(events)).not.toContain(real);
  });

  it("contract: the right value, with an activation, settles a critical request", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = await criticalRequest(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const issued = overlapCast(
      await (
        await app.request(
          `/v1/authorization-requests/${created.authReqId}/comparison`,
          { headers: { authorization: `Bearer ${requester.accessToken}` } },
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );
    const res = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: created.requestDigest,
        activationId,
        comparisonValue: issued.value,
      },
    );
    expect(res.status).toBe(200);
    expect(overlapCast(await res.json()).status).toBe("approved");
  });

  it("adversarial: a critical request cannot be settled without the comparison at all", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = await criticalRequest(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver.accessToken),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );
    const res = await settle(
      app,
      approver.accessToken,
      created.authReqId,
      "approve",
      {
        requestDigest: created.requestDigest,
        activationId,
      },
    );
    expect(res.status).toBe(403);
    expect(overlapCast(await res.json()).error).toBe("comparison_required");
  });
});

describe("digest compatibility", () => {
  it("property: a row carrying a pre-v2 digest still verifies and still settles", async () => {
    // Settlement compares the submitted digest against the value stored *with
    // the row*, never against a freshly derived one. That is what lets the
    // canonicalization change land without invalidating everything already in
    // the table.
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const legacyDigest = "a".repeat(64); // unprefixed hex: the v1 shape
    const row: AuthorizationRequest = {
      id: "areq_legacy_v1_row",
      principalId: approver.principalId,
      requesterRef: "req_someone",
      authorizationDetails: READ_ONLY_DETAILS.map((d) => overlapCast(d)),
      requestDigest: legacyDigest,
      bindingMessage: "Read acme/catalog issues",
      status: "pending",
      intervalSeconds: 5,
      createdAt: ctx.clock(),
      expiresAt: new Date(ctx.clock().getTime() + 300_000),
      version: 1,
    };
    await ctx.repos.authorizationRequests.create(row);

    const read = await app.request(
      "/v1/authorization-requests/areq_legacy_v1_row",
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(overlapCast(await read.json()).requestDigest).toBe(legacyDigest);

    const approved = await settle(
      app,
      approver.accessToken,
      "areq_legacy_v1_row",
      "approve",
      { requestDigest: legacyDigest },
    );
    expect(approved.status).toBe(200);
    expect(overlapCast(await approved.json()).status).toBe("approved");
    expect(requester.principalId).toBeTruthy();
  });

  it("property: the digest no longer depends on key order in the details", async () => {
    // The property ADR 0046 promises: an executor can recompute the digest
    // from the details it is about to act on. Two encoders that agree on the
    // JSON and disagree on key order must agree on the digest.
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const ref = await inboxRefOf(app, approver.accessToken);
    const first = overlapCast(
      await (
        await ask(app, requester.accessToken, ref, {
          authorizationDetails: [
            { type: "connection_delegation", actions: ["repository.read"] },
          ],
        })
      ).json(),
    );
    const second = overlapCast(
      await (
        await ask(app, requester.accessToken, ref, {
          authorizationDetails: [
            { actions: ["repository.read"], type: "connection_delegation" },
          ],
        })
      ).json(),
    );
    expect(second.requestDigest).toBe(first.requestDigest);
    expect(first.requestDigest.startsWith("v2:")).toBe(true);
    // Same digest, same live request: the dedupe below is the same fact seen
    // from the other side.
    expect(second.authReqId).toBe(first.authReqId);
  });
});

describe("anti-fatigue", () => {
  it("contract: asking the same thing twice returns the live request, not a second prompt", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const ref = await inboxRefOf(app, approver.accessToken);
    const first = await ask(app, requester.accessToken, ref);
    expect(first.status).toBe(201);
    const firstBody = overlapCast(await first.json());
    const second = await ask(app, requester.accessToken, ref);
    expect(second.status).toBe(200);
    expect(overlapCast(await second.json()).authReqId).toBe(
      firstBody.authReqId,
    );

    const inbox = await app.request(
      "/v1/authorization-requests?status=pending",
      {
        headers: { authorization: `Bearer ${approver.accessToken}` },
      },
    );
    expect(overlapCast(await inbox.json()).requests).toHaveLength(1);
  });

  it("adversarial: one requester cannot flood one approver", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const ref = await inboxRefOf(app, approver.accessToken);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await ask(app, requester.accessToken, ref, {
        bindingMessage: `Write to acme/catalog ${i}`,
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    // The budget is counted from stored rows, so it is the same budget on
    // every replica — a module-global map would only pace this one.
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(5);
  });

  it("adversarial: many requesters cannot flood one approver either", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const ref = await inboxRefOf(app, approver.accessToken);
    const statuses: number[] = [];
    // Six requesters, four asks each: under the per-pair budget every time,
    // and over the per-approver one. A limit that only counts one requester
    // is not a limit on being interrupted.
    for (let who = 0; who < 6; who += 1) {
      const requester = await principal(app);
      for (let i = 0; i < 4; i += 1) {
        const res = await ask(app, requester.accessToken, ref, {
          bindingMessage: `Write to acme/catalog ${who}-${i}`,
        });
        statuses.push(res.status);
      }
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(20);
  });
});

describe("reports and receipts", () => {
  it("contract: 'I don't recognize this' denies, raises a security event, and stays quiet", async () => {
    const { app, ctx } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const res = await app.request(
      `/v1/authorization-requests/${created.authReqId}/report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${approver.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestDigest: created.requestDigest,
          reason: "not_recognized",
        }),
      },
    );
    expect(res.status).toBe(200);
    // Denied — no authority granted — and notably without an activation: a
    // refusal is the safe direction and must never be the harder path.
    expect(overlapCast(await res.json()).status).toBe("denied");

    const events = await ctx.repos.auditEvents.list({ limit: 50 });
    expect(events.map((e) => e.eventType)).toContain(
      "security.approval.unrecognized",
    );

    // And it did not answer a suspicious prompt with more traffic.
    const outbox = await ctx.repos.outbox.listUnpublished();
    expect(
      outbox.filter((e) => e.eventType === "authority.invocation.completed"),
    ).toHaveLength(0);
  });

  it("contract: a receipt records what was required as well as what was met", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const stranger = await principal(app);
    const credentialId = await enrolPasskey(app, approver.accessToken);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const activationId = await activate(
      app,
      approver.accessToken,
      created.authReqId,
      created.requestDigest,
      "approved",
      credentialId,
    );
    await settle(app, approver.accessToken, created.authReqId, "approve", {
      requestDigest: created.requestDigest,
      activationId,
    });

    for (const who of [approver, requester]) {
      const res = await app.request(
        `/v1/authorization-requests/${created.authReqId}/receipt`,
        { headers: { authorization: `Bearer ${who.accessToken}` } },
      );
      expect(res.status).toBe(200);
      const receipt = overlapCast(await res.json());
      expect(receipt.decision).toBe("approved");
      expect(receipt.path).toBe("in_app");
      expect(receipt.requiredAssurance).toContain(
        "transaction_bound_activation",
      );
      expect(receipt.achievedAssurance).toContain("user_verification");
      expect(receipt.transactionDigest.startsWith("v1:")).toBe(true);
    }

    const nosy = await app.request(
      `/v1/authorization-requests/${created.authReqId}/receipt`,
      { headers: { authorization: `Bearer ${stranger.accessToken}` } },
    );
    expect(nosy.status).toBe(404);
  });

  it("contract: the requirement is published before the decision, in reason codes", async () => {
    const { app } = plane();
    const approver = await principal(app);
    const requester = await principal(app);
    const created = overlapCast(
      await (
        await ask(
          app,
          requester.accessToken,
          await inboxRefOf(app, approver.accessToken),
        )
      ).json(),
    );
    const res = await app.request(
      `/v1/authorization-requests/${created.authReqId}/requirement`,
      { headers: { authorization: `Bearer ${approver.accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    expect(body.riskClass).toBe("moderate");
    expect(body.requireTransactionBoundActivation).toBe(true);
    expect(body.required).toContain("user_verification");

    // Not the requester's to read: it describes what the approver must do.
    const asRequester = await app.request(
      `/v1/authorization-requests/${created.authReqId}/requirement`,
      { headers: { authorization: `Bearer ${requester.accessToken}` } },
    );
    expect(asRequester.status).toBe(404);
  });
});
