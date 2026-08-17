#!/usr/bin/env node
/**
 * Anonymous agent registration + claim poll demo.
 *
 *   OPENSESAME_API_URL=http://127.0.0.1:8788 pnpm --filter @opensesame/example-agent start
 *   MOCK_AGENT_FLOW=1 pnpm --filter @opensesame/example-agent start
 */
import { createHash, randomBytes } from "node:crypto";
import {
  RegisterAgentResponseSchema,
  ClaimSessionResponseSchema,
} from "@opensesame/contracts";
import { createControlPlaneClient, redactSecrets } from "@opensesame/sdk-cli";
import { renderAuthMd, renderAgentCard } from "@opensesame/agent-protocols";

const api = process.env.OPENSESAME_API_URL ?? "http://127.0.0.1:8788";

function jkt(): string {
  return createHash("sha256").update(randomBytes(32)).digest("base64url").slice(0, 43);
}

function createMockFetch(): typeof fetch {
  const claimId = "clm_demo";
  let polls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/agents/register") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          agentId: "agt_demo",
          instanceId: "inst_demo",
          projectId: "prj_demo_personal",
          state: "provisional",
          claimId,
          claimToken: "osc_clm_demo.secretvalue000000000000000000000000",
          userCode: "AGNT-CLAIM",
          verificationUri: "http://127.0.0.1:5173/claim",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      );
    }
    if (url.includes(`/api/v1/claims/${claimId}`)) {
      polls += 1;
      return new Response(
        JSON.stringify({
          id: claimId,
          type: "agent",
          state: polls < 2 ? "pending" : "completed",
          targetManifestDigest: "sha256:demo",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          version: 1,
          ...(polls >= 2 ? { completedByPrincipalId: "prn_demo" } : {}),
        }),
      );
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

export async function runAnonymousAgentDemo(options?: {
  fetchImpl?: typeof fetch;
  pollTimes?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ claimId: string; finalState: string }> {
  const fetchImpl =
    options?.fetchImpl ??
    (process.env.MOCK_AGENT_FLOW === "1" ? createMockFetch() : fetch);
  const cp = createControlPlaneClient({ baseUrl: api, fetchImpl });

  const raw = await cp.registerAnonymousAgent({
    displayName: "example-agent",
    publicKeyJkt: jkt(),
  });
  const registered = RegisterAgentResponseSchema.parse(raw);
  const safe = redactSecrets(registered);
  process.stdout.write(
    `Registered provisional agent ${registered.agentId}\n` +
      `Claim at: ${registered.verificationUri}\n` +
      `User code: ${registered.userCode}\n` +
      `Safe payload: ${JSON.stringify(safe)}\n`,
  );
  if (JSON.stringify(safe).includes(registered.claimToken)) {
    throw new Error("claimToken was not redacted");
  }

  const sleep =
    options?.sleep ??
    (async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const times = options?.pollTimes ?? 5;
  let finalState = "pending";
  for (let i = 0; i < times; i += 1) {
    const claimRaw = await cp.pollClaim(registered.claimId, registered.claimToken);
    const claim = ClaimSessionResponseSchema.parse(claimRaw);
    finalState = claim.state;
    process.stdout.write(`Claim poll ${i + 1}: state=${claim.state}\n`);
    if (claim.state === "completed" || claim.state === "denied" || claim.state === "expired") {
      break;
    }
    await sleep(50);
  }

  const authMd = renderAuthMd({
    serviceName: "OpenSesame",
    protectedResource: api,
    authorizationServer: api,
    consoleOrigin: "http://127.0.0.1:5173",
  });
  const card = renderAgentCard({
    name: "OpenSesame Agent API",
    url: api,
  });
  process.stdout.write(`\n--- auth.md preview (${authMd.split("\n")[0]}) ---\n`);
  process.stdout.write(`Agent card name: ${String(card.name)}\n`);

  return { claimId: registered.claimId, finalState };
}

const invokedDirectly = process.argv[1]?.includes("example-agent") ||
  process.argv[1]?.endsWith("main.ts");

if (invokedDirectly && process.env.VITEST !== "true") {
  runAnonymousAgentDemo().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
