/**
 * Durable OpenID4VP pending bindings across control-plane replicas.
 */

import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import {
  createTestKeyPair,
  issueCredential,
  present,
} from "../../../../packages/openid4vp/src/__fixtures__/holder.js";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

const ISSUER = "http://127.0.0.1:8788";
const VCT = "https://credentials.opensesame.local/opensesame-holder-binding/v1";

type Plane = ReturnType<typeof createControlPlane>;

type ReplicaDbOptions = {
  claimPepper: string;
  trustedIssuers?: NonNullable<
    Parameters<typeof createControlPlane>[0]
  >["openid4vpTrustedIssuers"];
  clock?: () => Date;
};

async function withReplicaDb(
  run: (first: Plane, second: Plane) => Promise<void>,
  options: ReplicaDbOptions,
) {
  resetInteractionLinkBudget();
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const shared: Parameters<typeof createControlPlane>[0] = {
      database: overlapCast(db),
      config: {
        publicUrl: ISSUER,
        issuer: ISSUER,
        claimPepper: options.claimPepper,
        isProduction: false,
        protocolFeatures: {
          oid4vp: true,
          oid4vci: false,
          fedcm: false,
          digitalCredentialsApi: false,
          openidFederation: false,
          sdJwtVc: false,
          tokenStatusList: false,
          presentationAgentIntents: false,
        },
      },
    };
    if (options.clock) shared.clock = options.clock;
    if (options.trustedIssuers) {
      shared.openid4vpTrustedIssuers = options.trustedIssuers;
    }
    const first = createControlPlane(shared);
    const second = createControlPlane(shared);
    await Promise.all([
      first.ctx.systemPrincipalReady,
      second.ctx.systemPrincipalReady,
    ]);
    await run(first, second);
  } finally {
    await client.close();
  }
}

async function mint(app: Plane["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast<{ accessToken: string; principalId: string }>(
    await res.json(),
  );
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function raiseOn(cp: Plane, subjectId: string, idempotencyKey: string) {
  const approver = await mint(cp.app);
  const requester = await mint(cp.app);
  seedOwnedCeremony(
    cp,
    "device_authorization",
    subjectId,
    requester.principalId,
  );
  const inbox = overlapCast<{ approverRef: string }>(
    await (
      await cp.app.request("/v1/authorization-requests/inbox-ref", {
        headers: bearer(approver.accessToken),
      })
    ).json(),
  ).approverRef;
  const created = overlapCast<{ ref: string; requestDigest: string }>(
    await (
      await cp.app.request("/v1/interactions", {
        method: "POST",
        headers: {
          ...bearer(requester.accessToken),
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          kind: "device_authorization",
          subject: { kind: "device_authorization", subjectId },
          approverRef: inbox,
          authorizationDetails: [
            {
              type: "connection_delegation",
              actions: ["repository.read"],
              locations: ["repo:acme/catalog"],
            },
          ],
          ttlSeconds: 300,
        }),
      })
    ).json(),
  );
  const opened = overlapCast<{ id: string }>(
    await (
      await cp.app.request(`/v1/interactions/${created.ref}`, {
        headers: bearer(approver.accessToken),
      })
    ).json(),
  );
  return { approver, requester, created, opened };
}

describe("durable OpenID4VP pending bindings", () => {
  it("admits a direct_post callback on a second replica after begin", async () => {
    await withReplicaDb(
      async (first, second) => {
        const { approver, requester, created, opened } = await raiseOn(
          first,
          "dev-oid4vp-pending-replica",
          "oid4vp-pending-replica-1",
        );
        seedOwnedCeremony(
          second,
          "device_authorization",
          "dev-oid4vp-pending-replica",
          requester.principalId,
        );
        const begun = await first.app.request("/v1/openid4vp/presentations", {
          method: "POST",
          headers: {
            ...bearer(approver.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            interactionId: opened.id,
            requestDigest: created.requestDigest,
          }),
        });
        expect(begun.status).toBe(200);
        const session = overlapCast<{ state: string }>(await begun.json());
        const onOtherReplica = await second.app.request(
          "/v1/openid4vp/response",
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `state=${encodeURIComponent(session.state)}&vp_token=%7B%7D`,
          },
        );
        expect(onOtherReplica.status).toBe(200);
        expect(
          overlapCast<{ status: string }>(await onOtherReplica.json()).status,
        ).toBe("received");
      },
      { claimPepper: "openid4vp-replica-pending-pepper-32b!" },
    );
  });

  it("completes a presentation on a second replica and refuses a replay", async () => {
    const issuerKey = await createTestKeyPair("ES256");
    const holderKey = await createTestKeyPair("ES256");
    await withReplicaDb(
      async (first, second) => {
        const { approver, requester, created, opened } = await raiseOn(
          first,
          "dev-oid4vp-pending-complete",
          "oid4vp-pending-complete-1",
        );
        seedOwnedCeremony(
          second,
          "device_authorization",
          "dev-oid4vp-pending-complete",
          requester.principalId,
        );
        const begun = await first.app.request("/v1/openid4vp/presentations", {
          method: "POST",
          headers: {
            ...bearer(approver.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            interactionId: opened.id,
            requestDigest: created.requestDigest,
          }),
        });
        expect(begun.status).toBe(200);
        const session = overlapCast<{
          state: string;
          parameters: {
            nonce: string;
            client_id: string;
            transaction_data?: string[];
          } | null;
        }>(await begun.json());
        if (!session.parameters) throw new Error("expected direct_post params");
        const transactionData = session.parameters.transaction_data ?? [];
        expect(transactionData.length).toBeGreaterThan(0);
        const transactionDataHashes = transactionData.map((entry) =>
          createHash("sha256").update(entry, "utf8").digest("base64url"),
        );
        const credential = await issueCredential({
          issuerKey,
          issuer: ISSUER,
          holderPublicJwk: holderKey.publicJwk,
          vct: VCT,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const vp = await present({
          credential,
          holderKey,
          audience: session.parameters.client_id,
          nonce: session.parameters.nonce,
          issuedAt: new Date(),
          transactionDataHashes,
          transactionDataHashesAlg: "sha-256",
        });
        const complete = await second.app.request(
          "/v1/openid4vp/presentations/complete",
          {
            method: "POST",
            headers: {
              ...bearer(approver.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              state: session.state,
              responseMode: "direct_post",
              body: {
                vp_token: { opensesame: [vp] },
                state: session.state,
              },
            }),
          },
        );
        expect(complete.status).toBe(200);
        const body = overlapCast<{ activationId: string; mechanism: string }>(
          await complete.json(),
        );
        expect(body.mechanism).toBe("openid4vp");
        expect(body.activationId).toMatch(/^act_/);
        const replay = await first.app.request(
          "/v1/openid4vp/presentations/complete",
          {
            method: "POST",
            headers: {
              ...bearer(approver.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              state: session.state,
              responseMode: "direct_post",
              body: {
                vp_token: { opensesame: [vp] },
                state: session.state,
              },
            }),
          },
        );
        expect(replay.status).toBe(404);
        expect(overlapCast<{ error: string }>(await replay.json()).error).toBe(
          "presentation_unknown",
        );
      },
      {
        claimPepper: "openid4vp-replica-complete-pepper-32b!",
        trustedIssuers: [{ issuer: ISSUER, keys: [issuerKey.publicJwk] }],
      },
    );
  });

  it("classifies an overdue durable pending binding as presentation_expired", async () => {
    let now = Date.parse("2026-09-17T12:00:00.000Z");
    await withReplicaDb(
      async (first) => {
        const { approver, created, opened } = await raiseOn(
          first,
          "dev-oid4vp-pending-expired",
          "oid4vp-pending-expired-1",
        );
        const begun = await first.app.request("/v1/openid4vp/presentations", {
          method: "POST",
          headers: {
            ...bearer(approver.accessToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            interactionId: opened.id,
            requestDigest: created.requestDigest,
          }),
        });
        expect(begun.status).toBe(200);
        const session = overlapCast<{ state: string }>(await begun.json());
        now = Date.parse("2026-09-17T13:00:00.000Z");
        const expired = await first.app.request("/v1/openid4vp/response", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `state=${encodeURIComponent(session.state)}&vp_token=%7B%7D`,
        });
        expect(expired.status).toBe(409);
        expect(overlapCast<{ error: string }>(await expired.json()).error).toBe(
          "presentation_expired",
        );
      },
      {
        claimPepper: "openid4vp-replica-expired-pepper-32byt!",
        clock: () => new Date(now),
      },
    );
  });
});
