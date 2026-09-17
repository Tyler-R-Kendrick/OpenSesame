/**
 * Hosted OpenID4VP verifier routes — presentation begin/complete gates.
 */

import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { verifiedPrincipal } from "./authentication-fixture.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

function plane() {
  return createControlPlane({
    config: {
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      claimPepper: "openid4vp-route-test-pepper-32bytes!",
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
  });
}

describe("hosted OpenID4VP routes (F08 / V-03)", () => {
  it("refuses an unauthenticated begin", async () => {
    const { app } = plane();
    const res = await app.request("/v1/openid4vp/presentations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ixn_does_not_exist",
        requestDigest: `sha256:${"a".repeat(64)}`,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses begin for an unknown interaction (T-09 shape)", async () => {
    const { app } = plane();
    const { auth } = await verifiedPrincipal(app);
    const res = await app.request("/v1/openid4vp/presentations", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "ixn_missing_subject_zzzz",
        requestDigest: `sha256:${"b".repeat(64)}`,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("does not settle from the public direct_post callback alone (T-23)", async () => {
    const { app } = plane();
    const res = await app.request("/v1/openid4vp/response", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "state=forged&vp_token=%7B%7D",
    });
    expect(res.status).toBe(404);
  });

  it("admits a direct_post callback on a second replica after begin", async () => {
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
      const options = {
        database: overlapCast(db),
        config: {
          publicUrl: "http://127.0.0.1:8788",
          issuer: "http://127.0.0.1:8788",
          claimPepper: "openid4vp-replica-pending-pepper-32b!",
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
      const first = createControlPlane(options);
      const second = createControlPlane(options);
      await Promise.all([
        first.ctx.systemPrincipalReady,
        second.ctx.systemPrincipalReady,
      ]);

      const mint = async (app: typeof first.app) => {
        const res = await app.request("/v1/principals/provisional", {
          method: "POST",
        });
        expect(res.status).toBe(201);
        return overlapCast<{ accessToken: string; principalId: string }>(
          await res.json(),
        );
      };
      const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

      const approver = await mint(first.app);
      const requester = await mint(first.app);
      seedOwnedCeremony(
        first,
        "device_authorization",
        "dev-oid4vp-pending-replica",
        requester.principalId,
      );
      seedOwnedCeremony(
        second,
        "device_authorization",
        "dev-oid4vp-pending-replica",
        requester.principalId,
      );

      const inbox = overlapCast<{ approverRef: string }>(
        await (
          await first.app.request("/v1/authorization-requests/inbox-ref", {
            headers: bearer(approver.accessToken),
          })
        ).json(),
      ).approverRef;
      const created = overlapCast<{ ref: string; requestDigest: string }>(
        await (
          await first.app.request("/v1/interactions", {
            method: "POST",
            headers: {
              ...bearer(requester.accessToken),
              "content-type": "application/json",
              "idempotency-key": "oid4vp-pending-replica-1",
            },
            body: JSON.stringify({
              kind: "device_authorization",
              subject: {
                kind: "device_authorization",
                subjectId: "dev-oid4vp-pending-replica",
              },
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
          await first.app.request(`/v1/interactions/${created.ref}`, {
            headers: bearer(approver.accessToken),
          })
        ).json(),
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
    } finally {
      await client.close();
    }
  });
});
