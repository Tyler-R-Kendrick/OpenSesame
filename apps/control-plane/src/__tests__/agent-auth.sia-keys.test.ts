import { PROVIDER_ID_JAG_TYP } from "@opensesame/agent-protocols";
import { overlapCast } from "@opensesame/os-domain";
import { generateClaimToken } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  agentAuthRuntime,
  resetAgentAuthRuntimeForTests,
} from "../services/agent-auth.js";

async function app() {
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

async function verifiedWithEmail(
  hono: ReturnType<typeof createControlPlane>["app"],
  email: string,
) {
  const created = await hono.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(created.status).toBe(201);
  const body = await json(created);
  const auth = { authorization: `Bearer ${body.accessToken}` };
  const linked = await hono.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `verify-${email}`,
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
  return { auth, principalId: String(body.principalId) };
}

describe("AgentAuth service assertion keys", () => {
  afterEach(() => {
    resetAgentAuthRuntimeForTests();
  });

  it("refuses an ephemeral signing key in production", async () => {
    resetAgentAuthRuntimeForTests();
    await expect(agentAuthRuntime({ NODE_ENV: "production" })).rejects.toThrow(
      /OPENSESAME_JWKS_JSON|OPENSESAME_AGENT_AUTH_SIA_JWK/,
    );
  });
});
