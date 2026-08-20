import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SYSTEM_OWNER_PRINCIPAL_ID } from "../create-app.js";
import type { startServer } from "../server.js";

type Started = Awaited<ReturnType<typeof startServer>>;
type App = Started["app"];

const OPERATOR_TOKEN = "test-operator-token";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * A static-site stand-in: serves (or refuses) the F5 well-known claim
 * document. Its port is the client's canonical origin.
 */
interface DocServer {
  server: http.Server;
  origin: string;
  clientId: string;
  host(document: Record<string, unknown> | null): void;
}

async function startDocServer(): Promise<DocServer> {
  let document: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/opensesame-client.json" && document) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(document));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_hosted" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin,
    clientId: `origin:${origin}`,
    host(doc) {
      document = doc;
    },
  };
}

async function stopDocServer(doc: DocServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    doc.server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function startControlPlane(clock?: () => Date): Promise<Started> {
  const { startServer: start } = await import("../server.js");
  return start({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      issuer: "http://127.0.0.1:0",
      operatorToken: OPERATOR_TOKEN,
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
    },
    ...(clock ? { clock } : {}),
  });
}

async function stop(started: Started): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    started.server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Auto-admit an origin client through the real /auth prefetch path. */
async function admit(started: Started, clientId: string, origin: string) {
  const { challenge } = pkce();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/opensesame/callback`,
    response_type: "code",
    scope: "openid",
    state: "s-1",
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return fetch(`http://127.0.0.1:${started.port}/auth?${params.toString()}`, {
    redirect: "manual",
  });
}

async function verifiedUser(app: App, subject: string) {
  const provisional = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(provisional.status).toBe(201);
  const created = (await provisional.json()) as {
    principalId: string;
    accessToken: string;
  };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return created;
}

function claimStart(app: App, clientId: string, token: string, body = {}) {
  return app.request(
    `/v1/oauth/applications/${encodeURIComponent(clientId)}/claim/start`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function claimVerify(app: App, clientId: string, token: string, body: unknown) {
  return app.request(
    `/v1/oauth/applications/${encodeURIComponent(clientId)}/claim/verify`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

interface StartedClaimBody {
  challengeId: string;
  challenge: string;
  wellKnownUrl: string;
  expiresAt: string;
  document: {
    application_id: string;
    origin: string;
    challenge: string;
    expires_at: string;
    issuer: string;
    owner_principal_id: string;
  };
}

async function startAndHostClaim(
  started: Started,
  doc: DocServer,
  token: string,
  principalId: string,
): Promise<StartedClaimBody> {
  const res = await claimStart(started.app, doc.clientId, token);
  expect(res.status).toBe(201);
  const startedClaim = (await res.json()) as StartedClaimBody;
  expect(startedClaim.wellKnownUrl).toBe(
    `${doc.origin}/.well-known/opensesame-client.json`,
  );
  expect(startedClaim.document).toMatchObject({
    application_id: doc.clientId,
    origin: doc.origin,
    challenge: startedClaim.challenge,
    issuer: "http://127.0.0.1:0",
    owner_principal_id: principalId,
  });
  doc.host(startedClaim.document as unknown as Record<string, unknown>);
  return startedClaim;
}

describe("origin claim flow (ADR 0050 F5/R-A, slice 3b)", () => {
  it("ensures the system principal and owns auto-admitted clients with it", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      const principal = await started.ctx.repos.principals.getById(
        SYSTEM_OWNER_PRINCIPAL_ID,
      );
      expect(principal).toMatchObject({ state: "active" });

      // Ensuring is idempotent across a second ensure on the same repos.
      const { ensureSystemOwnerPrincipal } = await import("../create-app.js");
      await expect(
        ensureSystemOwnerPrincipal(started.ctx.repos, started.ctx.clock),
      ).resolves.toBeUndefined();

      const res = await admit(started, doc.clientId, doc.origin);
      expect(res.status).toBe(303);
      const record = await started.ctx.oauth.clientStore.findById(doc.clientId);
      expect(record).toMatchObject({
        admissionMode: "origin_profile",
        ownershipStatus: "unclaimed",
        ownerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
      });
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("keeps unclaimed clients invisible to non-system principals (404, no oracle)", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);

      // Owner-fenced registration API: a foreign client answers 404.
      const patch = await started.app.request(
        `/v1/oauth/clients/${encodeURIComponent(doc.clientId)}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${user.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ displayName: "not mine" }),
        },
      );
      expect(patch.status).toBe(404);

      const listed = await started.app.request("/v1/oauth/clients", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const { clients } = (await listed.json()) as {
        clients: Array<{ id: string }>;
      };
      expect(clients.some((client) => client.id === doc.clientId)).toBe(false);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("runs claim start → verify end to end and transfers ownership", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);

      const startedClaim = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );

      const verify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(verify.status).toBe(200);
      const result = (await verify.json()) as {
        applicationId: string;
        sectorIdentifier: string;
        ownershipStatus: string;
      };
      expect(result).toMatchObject({
        applicationId: doc.clientId,
        ownershipStatus: "claimed",
      });

      // R-A: ownership transferred, claimedAt stamped, durably visible.
      const record = await started.ctx.oauth.clientStore.findById(doc.clientId);
      expect(record).toMatchObject({
        ownerPrincipalId: user.principalId,
        ownershipStatus: "claimed",
      });
      expect(record?.claimedAt).toBeInstanceOf(Date);

      // The new owner now sees the client through the owner-fenced API.
      const listed = await started.app.request("/v1/oauth/clients", {
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      const { clients } = (await listed.json()) as {
        clients: Array<{ id: string }>;
      };
      expect(clients.some((client) => client.id === doc.clientId)).toBe(true);

      const audit = await started.ctx.repos.auditEvents.list({ limit: 100 });
      expect(
        audit.some(
          (event) =>
            event.eventType === "oauth_client.claimed" &&
            event.clientId === doc.clientId &&
            event.principalId === user.principalId,
        ),
      ).toBe(true);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("requires a verified principal to start a claim", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const provisional = await started.app.request(
        "/v1/principals/provisional",
        { method: "POST" },
      );
      const { accessToken } = (await provisional.json()) as {
        accessToken: string;
      };

      const unauthenticated = await claimStart(started.app, doc.clientId, "");
      expect(unauthenticated.status).toBe(401);

      const res = await claimStart(started.app, doc.clientId, accessToken);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "assurance_too_low",
      );
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("refuses claims on unknown, foreign, and non-origin clients with 404", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const owner = await verifiedUser(started.app, `user-${randomUUID()}`);
      const other = await verifiedUser(started.app, `user-${randomUUID()}`);

      // Unknown application.
      const unknown = await claimStart(
        started.app,
        "origin:http://127.0.0.1:1",
        owner.accessToken,
      );
      expect(unknown.status).toBe(404);

      // Claimed by `owner`: foreign to `other`.
      const startedClaim = await startAndHostClaim(
        started,
        doc,
        owner.accessToken,
        owner.principalId,
      );
      const verify = await claimVerify(
        started.app,
        doc.clientId,
        owner.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(verify.status).toBe(200);
      const foreign = await claimStart(
        started.app,
        doc.clientId,
        other.accessToken,
      );
      expect(foreign.status).toBe(404);

      // A pre_registered client is not claimable through the origin flow.
      const registered = await started.app.request("/v1/oauth/clients", {
        method: "POST",
        headers: {
          authorization: `Bearer ${other.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Server RP",
          redirectUris: ["http://127.0.0.1:5173/callback"],
          sectorIdentifier: "https://server-rp.example",
        }),
      });
      expect(registered.status).toBe(201);
      const client = (await registered.json()) as { id: string };
      const preRegistered = await claimStart(
        started.app,
        client.id,
        other.accessToken,
      );
      expect(preRegistered.status).toBe(404);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("denies a wrong challenge document and leaves ownership unchanged", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);
      const startedClaim = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );

      // The hosted document carries a challenge the server never minted.
      doc.host({
        ...(startedClaim.document as unknown as Record<string, unknown>),
        challenge: randomBytes(32).toString("base64url"),
      });
      const verify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(verify.status).toBe(400);
      expect(((await verify.json()) as { error: string }).error).toBe(
        "proof_mismatch",
      );

      const record = await started.ctx.oauth.clientStore.findById(doc.clientId);
      expect(record).toMatchObject({
        ownerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
        ownershipStatus: "unclaimed",
      });
      expect(record?.claimedAt).toBeUndefined();
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("denies a document hosted at the wrong origin", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);
      const startedClaim = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );

      doc.host({
        ...(startedClaim.document as unknown as Record<string, unknown>),
        origin: "https://someone-else.example",
      });
      const verify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(verify.status).toBe(400);
      expect(((await verify.json()) as { error: string }).error).toBe(
        "proof_mismatch",
      );
      expect(
        (await started.ctx.oauth.clientStore.findById(doc.clientId))
          ?.ownerPrincipalId,
      ).toBe(SYSTEM_OWNER_PRINCIPAL_ID);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("denies an expired challenge", async () => {
    const doc = await startDocServer();
    let now = new Date("2026-08-20T12:00:00Z");
    const started = await startControlPlane(() => now);
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);
      const startedClaim = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );

      now = new Date(now.getTime() + 601_000);
      const verify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(verify.status).toBe(410);
      expect(((await verify.json()) as { error: string }).error).toBe(
        "challenge_expired",
      );
      expect(
        (await started.ctx.oauth.clientStore.findById(doc.clientId))
          ?.ownerPrincipalId,
      ).toBe(SYSTEM_OWNER_PRINCIPAL_ID);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("denies a replayed (consumed) challenge", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);
      const startedClaim = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );

      const first = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(first.status).toBe(200);

      const replay = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(replay.status).toBe(409);
      expect(((await replay.json()) as { error: string }).error).toBe(
        "challenge_consumed",
      );

      // A different principal can never replay someone else's challenge.
      const other = await verifiedUser(started.app, `user-${randomUUID()}`);
      const foreign = await claimVerify(
        started.app,
        doc.clientId,
        other.accessToken,
        {
          challenge: startedClaim.challenge,
        },
      );
      expect(foreign.status).toBe(403);

      const record = await started.ctx.oauth.clientStore.findById(doc.clientId);
      expect(record?.ownerPrincipalId).toBe(user.principalId);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("attaches a verified alias origin; re-attach is idempotent, cross-application attach conflicts", async () => {
    const doc = await startDocServer();
    const aliasDoc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);

      // Claim the canonical origin first.
      const first = await startAndHostClaim(
        started,
        doc,
        user.accessToken,
        user.principalId,
      );
      expect(
        (
          await claimVerify(started.app, doc.clientId, user.accessToken, {
            challenge: first.challenge,
          })
        ).status,
      ).toBe(200);
      expect(
        await started.ctx.stores.clientOrigins.listByApplication(doc.clientId),
      ).toHaveLength(0);

      // Now claim the alias origin for the same (now owned) application.
      const aliasStart = await claimStart(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          origin: aliasDoc.origin,
        },
      );
      expect(aliasStart.status).toBe(201);
      const aliasClaim = (await aliasStart.json()) as StartedClaimBody;
      expect(aliasClaim.document.origin).toBe(aliasDoc.origin);
      aliasDoc.host(aliasClaim.document as unknown as Record<string, unknown>);

      const aliasVerify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: aliasClaim.challenge,
          origin: aliasDoc.origin,
          attachAlias: true,
        },
      );
      expect(aliasVerify.status).toBe(200);
      expect(
        ((await aliasVerify.json()) as { aliasAttached: boolean })
          .aliasAttached,
      ).toBe(true);

      const attached = await started.ctx.stores.clientOrigins.listByApplication(
        doc.clientId,
      );
      expect(attached).toHaveLength(1);
      expect(attached[0]).toMatchObject({
        canonicalOrigin: aliasDoc.origin,
        publicClientId: aliasDoc.clientId,
        verificationMethod: "well-known",
        status: "active",
      });

      // Re-attach of the same alias for the same application is idempotent.
      const reStart = await claimStart(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          origin: aliasDoc.origin,
        },
      );
      const reClaim = (await reStart.json()) as StartedClaimBody;
      aliasDoc.host(reClaim.document as unknown as Record<string, unknown>);
      const reVerify = await claimVerify(
        started.app,
        doc.clientId,
        user.accessToken,
        {
          challenge: reClaim.challenge,
          origin: aliasDoc.origin,
          attachAlias: true,
        },
      );
      expect(reVerify.status).toBe(200);
      expect(
        await started.ctx.stores.clientOrigins.listByApplication(doc.clientId),
      ).toHaveLength(1);

      // A different application may not take the attached alias.
      const otherDoc = await startDocServer();
      try {
        await admit(started, otherDoc.clientId, otherDoc.origin);
        const stealStart = await claimStart(
          started.app,
          otherDoc.clientId,
          user.accessToken,
          { origin: aliasDoc.origin },
        );
        expect(stealStart.status).toBe(201);
        const stealClaim = (await stealStart.json()) as StartedClaimBody;
        aliasDoc.host(
          stealClaim.document as unknown as Record<string, unknown>,
        );
        const stealVerify = await claimVerify(
          started.app,
          otherDoc.clientId,
          user.accessToken,
          {
            challenge: stealClaim.challenge,
            origin: aliasDoc.origin,
            attachAlias: true,
          },
        );
        expect(stealVerify.status).toBe(409);
        expect(((await stealVerify.json()) as { error: string }).error).toBe(
          "alias_conflict",
        );
        // Ownership of the second application is untouched.
        expect(
          (await started.ctx.oauth.clientStore.findById(otherDoc.clientId))
            ?.ownerPrincipalId,
        ).toBe(SYSTEM_OWNER_PRINCIPAL_ID);
      } finally {
        await stopDocServer(otherDoc);
      }
    } finally {
      await stop(started);
      await stopDocServer(doc);
      await stopDocServer(aliasDoc);
    }
  });
});

describe("origin client admin suspend/revoke (ADR 0050 R-B, slice 3b)", () => {
  function adminCall(
    started: Started,
    clientId: string,
    action: string,
    token?: string,
  ) {
    return started.app.request(
      `/v1/oauth/admin/clients/${encodeURIComponent(clientId)}/${action}`,
      {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    );
  }

  it("gates admin routes on the operator token", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);

      const noToken = await adminCall(started, doc.clientId, "suspend");
      expect(noToken.status).toBe(401);

      const wrongToken = await adminCall(
        started,
        doc.clientId,
        "suspend",
        "nope",
      );
      expect(wrongToken.status).toBe(401);

      expect(
        (await started.ctx.oauth.clientStore.findById(doc.clientId))?.state,
      ).toBe("active");
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("suspends durably, audits, and the suspended client fails /auth", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      const admitted = await admit(started, doc.clientId, doc.origin);
      expect(admitted.status).toBe(303);

      const suspended = await adminCall(
        started,
        doc.clientId,
        "suspend",
        OPERATOR_TOKEN,
      );
      expect(suspended.status).toBe(200);
      expect(((await suspended.json()) as { state: string }).state).toBe(
        "suspended",
      );

      // Durable: the store itself reflects the transition (no overlay).
      expect(
        (await started.ctx.oauth.clientStore.findById(doc.clientId))?.state,
      ).toBe("suspended");

      const audit = await started.ctx.repos.auditEvents.list({ limit: 100 });
      expect(
        audit.some(
          (event) =>
            event.eventType === "oauth_client.suspended" &&
            event.clientId === doc.clientId &&
            event.actorId === "operator",
        ),
      ).toBe(true);

      // Repeating the same transition is idempotent.
      const again = await adminCall(
        started,
        doc.clientId,
        "suspend",
        OPERATOR_TOKEN,
      );
      expect(again.status).toBe(200);

      // The admission gate (client_inactive) rejects the suspended client on
      // /auth: oidc-provider renders an error instead of starting an
      // interaction.
      const rejected = await admit(started, doc.clientId, doc.origin);
      expect(rejected.status).toBe(400);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("revokes durably; revoke is terminal for suspend but idempotent itself", async () => {
    const doc = await startDocServer();
    const started = await startControlPlane();
    try {
      await admit(started, doc.clientId, doc.origin);

      const revoked = await adminCall(
        started,
        doc.clientId,
        "revoke",
        OPERATOR_TOKEN,
      );
      expect(revoked.status).toBe(200);
      expect(((await revoked.json()) as { state: string }).state).toBe(
        "revoked",
      );
      expect(
        (await started.ctx.oauth.clientStore.findById(doc.clientId))?.state,
      ).toBe("revoked");

      const audit = await started.ctx.repos.auditEvents.list({ limit: 100 });
      expect(
        audit.some(
          (event) =>
            event.eventType === "oauth_client.revoked" &&
            event.clientId === doc.clientId,
        ),
      ).toBe(true);

      const again = await adminCall(
        started,
        doc.clientId,
        "revoke",
        OPERATOR_TOKEN,
      );
      expect(again.status).toBe(200);

      const suspendAfterRevoke = await adminCall(
        started,
        doc.clientId,
        "suspend",
        OPERATOR_TOKEN,
      );
      expect(suspendAfterRevoke.status).toBe(409);
    } finally {
      await stop(started);
      await stopDocServer(doc);
    }
  });

  it("rejects non-origin clients and unknown ids from admin routes", async () => {
    const started = await startControlPlane();
    try {
      const user = await verifiedUser(started.app, `user-${randomUUID()}`);
      const registered = await started.app.request("/v1/oauth/clients", {
        method: "POST",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Server RP",
          redirectUris: ["http://127.0.0.1:5173/callback"],
          sectorIdentifier: "https://server-rp.example",
        }),
      });
      expect(registered.status).toBe(201);
      const client = (await registered.json()) as { id: string };

      const preRegistered = await adminCall(
        started,
        client.id,
        "suspend",
        OPERATOR_TOKEN,
      );
      expect(preRegistered.status).toBe(404);

      const unknown = await adminCall(
        started,
        "origin:https://unknown.example",
        "suspend",
        OPERATOR_TOKEN,
      );
      expect(unknown.status).toBe(404);

      expect(
        (await started.ctx.oauth.clientStore.findById(client.id))?.state,
      ).toBe("active");
    } finally {
      await stop(started);
    }
  });
});
