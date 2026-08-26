/**
 * `POST /v1/federated/byo-upstreams` — the JSON twin of the hosted page's BYO
 * form. The registration engine itself is exercised in byo-upstream.test.ts;
 * what this file pins is the route contract: the secret is never echoed, the
 * error codes map to the right statuses, and the abuse budget bites.
 */

import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetByoBudget } from "../interactions/byo.js";
import { buildLoginPageModel } from "../interactions/handlers.js";
import type { InteractionDetails } from "../interactions/types.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

type Plane = ReturnType<typeof createControlPlane>;

const HEADERS = {
  "content-type": "application/json",
  "user-agent": "byo-public-test",
  origin: "http://127.0.0.1:4317",
};

type HintParams = { login_hint_provider?: string };

type ByoWireBody = {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
};

async function post(plane: Plane, body: ByoWireBody) {
  const res = await plane.app.request("/v1/federated/byo-upstreams", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: overlapCast(await res.json()) };
}

describe("public BYO upstream registration", () => {
  let dcrIdp: ReferenceIdp;
  let noDcrIdp: ReferenceIdp;

  beforeAll(async () => {
    [dcrIdp, noDcrIdp] = await Promise.all([
      startReferenceIdp({ registration: true }),
      startReferenceIdp({ registration: false }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([dcrIdp.close(), noDcrIdp.close()]);
  });

  beforeEach(() => {
    resetByoBudget();
  });

  it("registers a DCR-capable issuer and never echoes the client secret", async () => {
    const plane = createControlPlane({ config: testConfig() });

    const { status, body } = await post(plane, { issuer: dcrIdp.issuer });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      issuer: dcrIdp.issuer,
      registrationSource: "dcr",
      redirectUri: "http://127.0.0.1:8788/v1/federated/callback",
    });
    expect(String(body.id)).toMatch(/^byo_/);
    expect(body.clientSecret).toBeUndefined();
    // The record itself keeps the secret — only the wire answer omits it.
    const stored = await plane.ctx.repos.byoUpstreams.findByIssuer(
      dcrIdp.issuer,
    );
    expect(stored?.clientSecret).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(String(stored?.clientSecret));
  });

  it("answers 422 registration_unsupported when the issuer cannot self-register", async () => {
    const plane = createControlPlane({ config: testConfig() });

    const { status, body } = await post(plane, { issuer: noDcrIdp.issuer });

    expect(status).toBe(422);
    expect(body).toEqual({
      error: "registration_unsupported",
      message: expect.stringContaining("client ID"),
    });
  });

  it("accepts a visitor-supplied client for that same issuer", async () => {
    const plane = createControlPlane({ config: testConfig() });

    const { status, body } = await post(plane, {
      issuer: noDcrIdp.issuer,
      clientId: "manual-client",
      clientSecret: "manual-secret",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      clientId: "manual-client",
      clientAuth: "client_secret_post",
      registrationSource: "manual",
    });
    expect(JSON.stringify(body)).not.toContain("manual-secret");
  });

  it("answers 400 for a body with no issuer", async () => {
    const plane = createControlPlane({ config: testConfig() });

    const { status, body } = await post(plane, { clientId: "c" });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("renders a registered issuer as the login page's preferred button when hinted", async () => {
    const plane = createControlPlane({ config: testConfig() });
    await post(plane, { issuer: dcrIdp.issuer });

    const details = (params: HintParams): InteractionDetails =>
      overlapCast({
        uid: "uid-1",
        params,
        prompt: { name: "login", details: {} },
      });

    const hinted = await buildLoginPageModel(
      plane.ctx,
      details({ login_hint_provider: dcrIdp.issuer }),
      "csrf-token",
      undefined,
    );
    expect(hinted.federated?.preferredIssuer).toBe(dcrIdp.issuer);
    expect(hinted.federated?.upstreams).toContainEqual({
      issuer: dcrIdp.issuer,
      label: new URL(dcrIdp.issuer).host,
    });

    // An unknown hint adds nothing — presentation only, never trust.
    const unknown = await buildLoginPageModel(
      plane.ctx,
      details({ login_hint_provider: "https://stranger.example" }),
      "csrf-token",
      undefined,
    );
    expect(unknown.federated?.preferredIssuer).toBeUndefined();
    expect(
      unknown.federated?.upstreams.some(
        (upstream) => upstream.issuer === "https://stranger.example",
      ),
    ).toBe(false);
  });

  it("answers 429 once the same fingerprint spends its budget", async () => {
    const plane = createControlPlane({ config: testConfig() });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { status } = await post(plane, { issuer: dcrIdp.issuer });
      expect(status).toBe(200);
    }
    const { status, body } = await post(plane, { issuer: dcrIdp.issuer });

    expect(status).toBe(429);
    expect(body.error).toBe("rate_limited");
  });
});
