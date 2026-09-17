import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { ConflictError } from "@opensesame/database";
import {
  type JsonObject,
  overlapCast,
  resolveInteractionRef,
} from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { verifyInteractionBinding } from "../routes/subject-adapters.js";
import {
  beginInteractionActivation,
  completeInteractionActivation,
  assertionFor as fixtureAssertion,
  enrolPasskey as fixtureEnrol,
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
      "idempotency-key": `matrix-${++seq}`,
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

const credentialKeys = new Map<string, KeyObject>();

async function enrolPasskey(cp: Plane, principalId: string): Promise<string> {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("public coordinates missing");
  const publicKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = randomBytes(16).toString("base64url");
  await cp.ctx.passkeys.register(principalId, {
    credentialId,
    publicKey,
    counter: 0,
  });
  credentialKeys.set(credentialId, key.privateKey);
  return credentialId;
}

function assertionFor(challenge: string, credentialId: string): JsonObject {
  const privateKey = credentialKeys.get(credentialId);
  if (!privateKey) throw new Error(`no signing key for ${credentialId}`);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: "http://127.0.0.1:8788",
    }),
  );
  const authData = Buffer.concat([
    createHash("sha256").update("127.0.0.1").digest(),
    Buffer.from([0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    privateKey,
  );
  return {
    credentialId,
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

async function activate(
  cp: Plane,
  token: string,
  ref: string,
  requestDigest: string,
  credentialId: string,
): Promise<string> {
  const begun = await cp.app.request(`/v1/interactions/${ref}/activation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approved", requestDigest }),
  });
  expect(begun.status).toBe(201);
  const body = overlapCast(await begun.json());
  const completed = await cp.app.request(
    `/v1/interactions/${ref}/activation/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        activationId: body.activationId,
        ...assertionFor(String(body.options.challenge), credentialId),
      }),
    },
  );
  expect(completed.status).toBe(200);
  return String(body.activationId);
}

beforeEach(() => {
  resetInteractionLinkBudget();
});

describe("interaction approval matrix (ADR 0125)", () => {
  it("T-04: a webauthn approval records mechanism webauthn on the audit row", async () => {
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
    const activationId = await activate(
      cp,
      approver.accessToken,
      String(created.ref),
      String(created.requestDigest),
      credentialId,
    );
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
          activationId,
        }),
      },
    );
    expect(approved.status).toBe(200);
    const events = await cp.ctx.repos.auditEvents.list({ limit: 500 });
    const row = events.find((e) => e.eventType === "interaction.approved");
    expect(row?.metadata?.mechanism).toBe("webauthn");
  });

  it("T-08: revoke during a minted activation refuses complete and approve", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await enrolPasskey(cp, String(approver.principalId));
    const begun = await beginInteractionActivation(
      cp,
      String(approver.accessToken),
      String(created.ref),
      String(created.requestDigest),
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
      String(approver.accessToken),
      String(created.ref),
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
  });

  it("T-09: a fabricated authorization_request subject is 404", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const res = await raise(cp, requester, await inboxRefOf(cp, approver), {
      kind: "authorization_request",
      subject: {
        kind: "authorization_request",
        subjectId: "areq_does_not_exist",
      },
    });
    expect(res.status).toBe(404);
  });

  it("T-10: envelope kind and subject kind mismatch is 400+", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const res = await raise(cp, requester, await inboxRefOf(cp, approver), {
      kind: "transaction_authorization",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("T-16: verifyInteractionBinding refuses a resourceRef swap", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    const id = resolveInteractionRef(
      String(created.ref),
      cp.ctx.config.claimPepper,
    );
    const row = await cp.ctx.repos.interactions.getById(id ?? "");
    if (!row?.requestDigest) throw new Error("missing interaction");
    const approved = {
      ...row,
      status: "approved" as const,
      approvalProof: {
        mechanism: "webauthn" as const,
        boundDigest: row.requestDigest,
        assurance: "phishing_resistant" as const,
        verifiedAt: cp.ctx.clock(),
      },
    };
    expect(verifyInteractionBinding(cp.ctx, approved).ok).toBe(true);
    expect(
      verifyInteractionBinding(cp.ctx, {
        ...approved,
        resourceRef: "res_swapped",
      }),
    ).toEqual({ ok: false, reason: "digest_recompute_mismatch" });
  });

  it("T-38: committing an expired reservation lease throws", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    const id = resolveInteractionRef(
      String(created.ref),
      cp.ctx.config.claimPepper,
    );
    const held = await cp.ctx.repos.executionReservations.acquire({
      id: `xrsv_${randomBytes(12).toString("base64url")}`,
      interactionId: id ?? "",
      requestDigest: String(created.requestDigest),
      holderRef: "t-38",
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      cp.ctx.repos.executionReservations.commit(
        held.id,
        held.fencingToken,
        new Date(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("T-44: a forged assertion fails the factory-wired verifier", async () => {
    const cp = plane();
    expect(cp.ctx.hostAuthorizationPasskeys).not.toBe(cp.ctx.passkeys);
    const approver = await principal(cp);
    const requester = await principal(cp);
    const created = overlapCast(
      await (await raise(cp, requester, await inboxRefOf(cp, approver))).json(),
    );
    await cp.app.request(`/v1/interactions/${created.ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await fixtureEnrol(cp, String(approver.principalId));
    const begun = await beginInteractionActivation(
      cp,
      String(approver.accessToken),
      String(created.ref),
      String(created.requestDigest),
    );
    expect(begun.status).toBe(201);
    const forged = fixtureAssertion(begun.challenge, credentialId);
    forged.signature = Buffer.from("forged-not-a-webauthn-signature").toString(
      "base64url",
    );
    const completed = await completeInteractionActivation(
      cp,
      String(approver.accessToken),
      String(created.ref),
      begun.activationId,
      forged,
    );
    expect(completed.status).toBe(401);
    expect(await completed.json()).toEqual({
      error: "activation_verification_failed",
    });
  });
});
