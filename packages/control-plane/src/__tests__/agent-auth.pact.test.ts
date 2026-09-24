import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentAnonymousRegistrationResponseSchema,
  AgentIdentityRequestSchema,
} from "@opensesame/contracts";
import { overlapCast } from "@opensesame/os-domain";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(
  join(here, "../services/agent-auth.ts"),
  "utf8",
);
const INSTRUMENTED = serviceSource.includes("stryMutAct_");
const describeSourceOracle = INSTRUMENTED ? describe.skip : describe;

describeSourceOracle("PACT — AgentAuth fail-closed ordering", () => {
  it("registers a principal before it mints a service assertion", () => {
    assertSourceOrder(serviceSource, [
      "export async function registerAnonymous",
      "await ctx.repos.transaction",
      "await mintAssertion",
    ]);
  });

  it("revokes pre-claim tokens inside the claim transaction, before audit", () => {
    assertSourceOrder(serviceSource, [
      "export async function completeClaim",
      "claimAgentRegistration",
      "revokeAccessTokensForRegistration",
      "agent_auth.claim.confirmed",
    ]);
  });
});

describe("PACT — AgentAuth wire contract", () => {
  it("anonymous registration responses parse as the published contract", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const res = await app.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "anonymous" }),
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    expect(
      AgentAnonymousRegistrationResponseSchema.parse(body).registration_type,
    ).toBe("anonymous");
    expect(AgentIdentityRequestSchema.parse({ type: "anonymous" }).type).toBe(
      "anonymous",
    );
  });
});
