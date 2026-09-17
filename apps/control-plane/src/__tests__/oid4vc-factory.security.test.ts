/** Independent in-repo client against createControlPlane OID4VP/OID4VCI HTTP. */

import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  createTestKeyPair,
  issueCredential,
  present,
} from "../../../../packages/openid4vp/src/__fixtures__/holder.js";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

const ISSUER = "https://127.0.0.1:8788";
const VCT = "https://credentials.opensesame.local/opensesame-holder-binding/v1";
const PRE_AUTH = "urn:ietf:params:oauth:grant-type:pre-authorized_code";

type Plane = ReturnType<typeof createControlPlane>;

function plane(extras: Parameters<typeof createControlPlane>[0] = {}): Plane {
  resetInteractionLinkBudget();
  const { config, ...rest } = extras;
  return createControlPlane({
    config: {
      port: 0,
      isProduction: false,
      claimPepper: "oid4vc-factory-test-pepper-32bytes!!",
      ...config,
      publicUrl: ISSUER,
      issuer: ISSUER,
    },
    ...rest,
  });
}

async function principal(app: Plane["app"]) {
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

async function raiseDeviceInteraction(
  cp: Plane,
  idempotencyKey: string,
  subjectId: string,
) {
  const app = cp.app;
  const approver = await principal(app);
  const requester = await principal(app);
  seedOwnedCeremony(
    cp,
    "device_authorization",
    subjectId,
    requester.principalId,
  );
  const inbox = overlapCast<{ approverRef: string }>(
    await (
      await app.request("/v1/authorization-requests/inbox-ref", {
        headers: bearer(approver.accessToken),
      })
    ).json(),
  ).approverRef;
  const created = overlapCast<{ ref: string; requestDigest: string }>(
    await (
      await app.request("/v1/interactions", {
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
      await app.request(`/v1/interactions/${created.ref}`, {
        headers: bearer(approver.accessToken),
      })
    ).json(),
  );
  return { approver, requester, created, opened };
}

async function beginDirectPost(
  app: Plane["app"],
  accessToken: string,
  interactionId: string,
  requestDigest: string,
) {
  const begun = await app.request("/v1/openid4vp/presentations", {
    method: "POST",
    headers: {
      ...bearer(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ interactionId, requestDigest }),
  });
  expect(begun.status).toBe(200);
  const session = overlapCast<{
    state: string;
    parameters: { nonce: string; client_id: string } | null;
    digests: { protocol: string; approval: string };
  }>(await begun.json());
  expect(session.digests.protocol).not.toBe(session.digests.approval);
  if (!session.parameters) throw new Error("expected direct_post parameters");
  return session;
}

describe("createControlPlane OID4VC routes are live", () => {
  it("advertises verifier and issuer without a feature-flag override", async () => {
    const { app } = plane();
    const caps = overlapCast<{
      capabilities: { id: string; state: string }[];
    }>(await (await app.request("/v1/wallet-native/capabilities")).json());
    const byId = Object.fromEntries(
      caps.capabilities.map((row) => [row.id, row.state]),
    );
    expect(byId["openid4vp.verifier"]).toBe("available");
    expect(byId["openid4vci.issuer"]).toBe("available");
    expect((await app.request("/v1/openid4vp/ping")).status).toBe(200);
    expect(
      (await app.request("/.well-known/openid-credential-issuer")).status,
    ).toBe(200);
  });

  it("lets an independent holder complete pre-authorized issuance", async () => {
    const { app: live } = plane();
    const mintedWho = await principal(live);
    const auth = bearer(mintedWho.accessToken);
    const minted = overlapCast<{ offerUri: string }>(
      await (
        await live.request("/oid4vci/offers", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: "{}",
        })
      ).json(),
    );
    expect(minted.offerUri).toContain("/oid4vci/offers/");
    const offerPath = new URL(minted.offerUri).pathname;
    const offerRes = await live.request(offerPath, { headers: auth });
    expect(offerRes.status).toBe(200);
    const offer = overlapCast<{ grants: JsonObject }>(await offerRes.json());
    const grant = overlapCast<{ "pre-authorized_code": string }>(
      offer.grants[PRE_AUTH],
    );
    const nonce = overlapCast<{ c_nonce: string }>(
      await (await live.request("/oid4vci/nonce", { method: "POST" })).json(),
    );
    const holder = await generateKeyPair("ES256", { extractable: true });
    const proof = await new SignJWT({ nonce: nonce.c_nonce })
      .setProtectedHeader({
        alg: "ES256",
        typ: "openid4vci-proof+jwt",
        jwk: await exportJWK(holder.publicKey),
      })
      .setIssuedAt()
      .setAudience(ISSUER)
      .sign(holder.privateKey);
    const tokenRes = await live.request("/oid4vci/token", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: PRE_AUTH,
        "pre-authorized_code": grant["pre-authorized_code"],
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = overlapCast<{ access_token: string }>(await tokenRes.json());
    const issued = await live.request("/oid4vci/credential", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        proof: { proof_type: "jwt", jwt: proof },
      }),
    });
    expect(issued.status).toBe(200);
    expect(overlapCast(await issued.json()).credential).toEqual(
      expect.any(String),
    );
  });
});

describe("OID4VP HTTP (T-18, T-20, T-21)", () => {
  it("T-21: an encrypted courier body cannot settle", async () => {
    const { app } = plane();
    const res = await app.request("/v1/openid4vp/response", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "response=eyJhbGciOiJFQ0RILUVTIn0..aXY.Y2lwaGVy.dGFn",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("T-18: a presentation signed by the wrong holder key is refused", async () => {
    const issuerKey = await createTestKeyPair("ES256");
    const holderKey = await createTestKeyPair("ES256");
    const otherKey = await createTestKeyPair("ES256");
    const cp = plane({
      openid4vpTrustedIssuers: [
        { issuer: ISSUER, keys: [issuerKey.publicJwk] },
      ],
    });
    const { approver, created, opened } = await raiseDeviceInteraction(
      cp,
      "oid4vp-t18",
      "dev-oid4vp-1",
    );
    const session = await beginDirectPost(
      cp.app,
      approver.accessToken,
      opened.id,
      created.requestDigest,
    );
    const credential = await issueCredential({
      issuerKey,
      issuer: ISSUER,
      holderPublicJwk: holderKey.publicJwk,
      vct: VCT,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const wrongPerson = await present({
      credential,
      holderKey: otherKey,
      audience: session.parameters.client_id,
      nonce: session.parameters.nonce,
      issuedAt: new Date(),
    });
    const completeWrong = await cp.app.request(
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
            vp_token: { opensesame: [wrongPerson] },
            state: session.state,
          },
        }),
      },
    );
    expect(completeWrong.status).toBeGreaterThanOrEqual(400);
  });

  it("T-15: a presentation with a swapped nonce cannot settle", async () => {
    const issuerKey = await createTestKeyPair("ES256");
    const holderKey = await createTestKeyPair("ES256");
    const cp = plane({
      openid4vpTrustedIssuers: [
        { issuer: ISSUER, keys: [issuerKey.publicJwk] },
      ],
    });
    const { approver, created, opened } = await raiseDeviceInteraction(
      cp,
      "oid4vp-t15",
      "dev-oid4vp-t15",
    );
    const session = await beginDirectPost(
      cp.app,
      approver.accessToken,
      opened.id,
      created.requestDigest,
    );
    const credential = await issueCredential({
      issuerKey,
      issuer: ISSUER,
      holderPublicJwk: holderKey.publicJwk,
      vct: VCT,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const swapped = await present({
      credential,
      holderKey,
      audience: session.parameters.client_id,
      nonce: `${session.parameters.nonce}x`,
      issuedAt: new Date(),
    });
    const complete = await cp.app.request(
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
            vp_token: { opensesame: [swapped] },
            state: session.state,
          },
        }),
      },
    );
    expect(complete.status).toBeGreaterThanOrEqual(400);
  });
});

describe("T-12 expiry at approve/consume", () => {
  it("refuses approve and consume after the interaction expires", async () => {
    let now = Date.parse("2026-09-17T12:00:00.000Z");
    const cp = plane({ clock: () => new Date(now) });
    const approver = await principal(cp.app);
    const requester = await principal(cp.app);
    seedOwnedCeremony(
      cp,
      "device_authorization",
      "dev-t12",
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
            "idempotency-key": "t12-expiry",
          },
          body: JSON.stringify({
            kind: "device_authorization",
            subject: { kind: "device_authorization", subjectId: "dev-t12" },
            approverRef: inbox,
            authorizationDetails: [
              {
                type: "connection_delegation",
                actions: ["repository.read"],
                locations: ["repo:acme/catalog"],
              },
            ],
            ttlSeconds: 30,
          }),
        })
      ).json(),
    );
    now += 31_000;
    const approved = await cp.app.request(
      `/v1/interactions/${created.ref}/approve`,
      {
        method: "POST",
        headers: {
          ...bearer(approver.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestDigest: created.requestDigest }),
      },
    );
    expect(approved.status).toBe(410);
    const spent = await cp.app.request(
      `/v1/interactions/${created.ref}/consume`,
      {
        method: "POST",
        headers: bearer(requester.accessToken),
      },
    );
    expect(spent.status).toBe(410);
  });
});
