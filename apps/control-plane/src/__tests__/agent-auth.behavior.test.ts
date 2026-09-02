import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * Behaviour specifications for the auth.md AgentAuth journeys.
 *
 * Structured Given/When/Then without a second framework: the unit and PACT
 * suites cover the pieces; these cover the paths an agent actually walks.
 */

type App = ReturnType<typeof createControlPlane>["app"];

function aDeployment(): App {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

async function json(res: Response) {
  return overlapCast(await res.json());
}

async function anAgentRegistersAnonymously(app: App) {
  const res = await app.request("/agent/identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "anonymous" }),
  });
  expect(res.status, "an unknown agent can register without an account").toBe(
    200,
  );
  return json(res);
}

async function theAgentExchangesItsAssertion(app: App, assertion: string) {
  const res = await app.request("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  expect(res.status).toBe(200);
  return json(res);
}

async function aHumanSignsInWithEmail(app: App, email: string) {
  const created = await json(
    await app.request("/v1/principals/provisional", { method: "POST" }),
  );
  const auth = { authorization: `Bearer ${created.accessToken}` };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `journey-${email}`,
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: `sub-${email}`,
      emailNormalized: email,
      emailVerified: true,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return { auth, principalId: created.principalId as string };
}

describe("AgentAuth journeys", () => {
  it("Given an unknown agent, When it registers anonymously, Then it can read with pre-claim scopes only", async () => {
    const app = aDeployment();
    const registered = await anAgentRegistersAnonymously(app);
    const token = await theAgentExchangesItsAssertion(
      app,
      String(registered.identity_assertion),
    );
    const demo = await json(
      await app.request("/v1/agent-resources/demo", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(demo.claimed).toBe(false);
    expect(String(token.scope)).not.toContain("claim:create");
  });

  it("Given a claimed registration, When the agent polls the claim grant, Then the old pre-claim token is dead", async () => {
    const app = aDeployment();
    const registered = await anAgentRegistersAnonymously(app);
    const pre = await theAgentExchangesItsAssertion(
      app,
      String(registered.identity_assertion),
    );
    const started = await json(
      await app.request("/agent/identity/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim_token: registered.claim_token,
          email: "owner@example.com",
        }),
      }),
    );
    const userCode = overlapCast(started.claim_attempt).user_code as string;
    const returnTo = new URL(
      String(overlapCast(started.claim_attempt).verification_uri),
    ).searchParams.get("return_to");
    const claimAttemptToken = new URL(
      returnTo ?? "",
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");
    const human = await aHumanSignsInWithEmail(app, "owner@example.com");
    const completed = await app.request("/agent/identity/claim/complete", {
      method: "POST",
      headers: { ...human.auth, "content-type": "application/json" },
      body: JSON.stringify({
        claim_attempt_token: claimAttemptToken,
        user_code: userCode,
      }),
    });
    expect(completed.status).toBe(200);

    const stale = await app.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${pre.access_token}` },
    });
    expect(stale.status).toBe(401);

    const polled = await json(
      await app.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:workos:agent-auth:grant-type:claim",
          claim_token: String(registered.claim_token),
        }),
      }),
    );
    expect(String(polled.scope)).toContain("claim:create");
  });

  it("Given a live access token, When it is revoked, Then the assertion can mint another", async () => {
    const app = aDeployment();
    const registered = await anAgentRegistersAnonymously(app);
    const token = await theAgentExchangesItsAssertion(
      app,
      String(registered.identity_assertion),
    );
    const revoked = await app.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: String(token.access_token),
        token_type_hint: "access_token",
      }),
    });
    expect(revoked.status).toBe(200);
    const dead = await app.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(dead.status).toBe(401);
    const minted = await theAgentExchangesItsAssertion(
      app,
      String(registered.identity_assertion),
    );
    expect(minted.access_token).not.toBe(token.access_token);
  });

  it("Given only an email hint, When the agent uses service_auth, Then no assertion is issued until claim", async () => {
    const app = aDeployment();
    const registered = await json(
      await app.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "service_auth",
          login_hint: "hint@example.com",
        }),
      }),
    );
    expect(registered.identity_assertion).toBeUndefined();
    expect(registered.claim).toBeTruthy();
  });
});
