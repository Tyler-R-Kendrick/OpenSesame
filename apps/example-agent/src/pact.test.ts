import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSecretFields, assertSourceOrder } from "@opensesame/testing";
import { runAnonymousAgentDemo } from "./main.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — example-agent", () => {
  it("property: mock claim poll reaches completed", async () => {
    process.env.MOCK_AGENT_FLOW = "1";
    const result = await runAnonymousAgentDemo({
      pollTimes: 3,
      sleep: async () => undefined,
    });
    expect(result.claimId).toBe("clm_demo");
    expect(result.finalState).toBe("completed");
  });

  it("adversarial: redacted payload must not include claimToken", () => {
    assertSourceOrder(readFileSync(join(here, "main.ts"), "utf8"), [
      "redactSecrets(registered)",
      "if (JSON.stringify(safe).includes(registered.claimToken))",
      "throw new Error(\"claimToken was not redacted\")",
    ]);
  });

  it("chaos: a poll partition fails closed rather than inventing a completed claim", async () => {
    process.env.MOCK_AGENT_FLOW = "1";
    let polls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/principals/provisional") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            principalId: "prn_demo_guest",
            state: "provisional",
            assurance: "provisional",
            sessionId: "ps_demo",
            accessToken: "pst_demo",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/agents") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            agentId: "agt_demo",
            instanceId: "inst_demo",
            projectId: "prj_demo_personal",
            state: "provisional",
            claimId: "clm_demo",
            claimToken: "osc_clm_demo.secretvalue000000000000000000000000",
            userCode: "AGNT-CLAIM",
            verificationUri: "http://127.0.0.1:5173/claim",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        );
      }
      polls += 1;
      if (polls === 1) throw new Error("partition");
      return new Response(
        JSON.stringify({
          id: "clm_demo",
          type: "agent",
          state: "pending",
          targetManifestDigest: "sha256:demo",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          version: 1,
        }),
      );
    }) as typeof fetch;
    await expect(
      runAnonymousAgentDemo({
        fetchImpl,
        pollTimes: 2,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/partition/);
  });

  it("contract: printed auth.md preview is generated from agent-protocols", () => {
    assertNoSecretFields({ claimId: "clm_demo", finalState: "completed" });
    const src = readFileSync(join(here, "main.ts"), "utf8");
    expect(src).toContain("renderAuthMd");
    expect(src).toContain("redactSecrets");
  });
});
