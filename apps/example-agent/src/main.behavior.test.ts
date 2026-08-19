import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, runAnonymousAgentDemo } from "./main.js";

const CLAIM_ID = "clm_demo";
const CLAIM_TOKEN = "osc_clm_demo.secretvalue000000000000000000000000";

function makeFetchImpl(options?: {
  claimStates?: string[];
  verificationUri?: string;
}): typeof fetch {
  const claimStates = options?.claimStates ?? ["pending", "completed"];
  let polls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
          claimId: CLAIM_ID,
          claimToken: CLAIM_TOKEN,
          userCode: "AGNT-CLAIM",
          verificationUri:
            options?.verificationUri ?? "http://127.0.0.1:5173/claim",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      );
    }
    if (url.includes(`/v1/claims/${CLAIM_ID}`)) {
      const state = claimStates[Math.min(polls, claimStates.length - 1)];
      polls += 1;
      return new Response(
        JSON.stringify({
          id: CLAIM_ID,
          type: "agent",
          state,
          targetManifestDigest: "sha256:demo",
          items: [],
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          version: 1,
          ...(state === "completed"
            ? { completedByPrincipalId: "prn_demo" }
            : {}),
        }),
      );
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

describe("example-agent behavior", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stops polling when the claim is denied", async () => {
    const result = await runAnonymousAgentDemo({
      fetchImpl: makeFetchImpl({ claimStates: ["pending", "denied"] }),
      pollTimes: 5,
      sleep: async () => undefined,
    });
    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.finalState).toBe("denied");
  });

  it("stops polling when the claim expires", async () => {
    const result = await runAnonymousAgentDemo({
      fetchImpl: makeFetchImpl({ claimStates: ["expired"] }),
      pollTimes: 5,
      sleep: async () => undefined,
    });
    expect(result.finalState).toBe("expired");
  });

  it("keeps polling until pollTimes when the claim stays pending", async () => {
    const result = await runAnonymousAgentDemo({
      fetchImpl: makeFetchImpl({ claimStates: ["pending"] }),
      pollTimes: 3,
      sleep: async () => undefined,
    });
    expect(result.finalState).toBe("pending");
  });

  it("fails closed if the redacted payload still leaks the claimToken", async () => {
    const fetchImpl = makeFetchImpl({
      verificationUri: `http://127.0.0.1:5173/claim?token=${CLAIM_TOKEN}`,
    });
    await expect(
      runAnonymousAgentDemo({ fetchImpl, sleep: async () => undefined }),
    ).rejects.toThrow("claimToken was not redacted");
  });

  it("uses the default sleep and poll count when options are omitted", async () => {
    const result = await runAnonymousAgentDemo({
      fetchImpl: makeFetchImpl(),
    });
    expect(result.finalState).toBe("completed");
  });

  it("falls back to global fetch when the mock flow is disabled", async () => {
    vi.stubEnv("MOCK_AGENT_FLOW", "");
    vi.stubGlobal("fetch", makeFetchImpl());
    const result = await runAnonymousAgentDemo({
      sleep: async () => undefined,
    });
    expect(result.claimId).toBe(CLAIM_ID);
    expect(result.finalState).toBe("completed");
  });

  it("mock fetch fails loudly on unexpected URLs", async () => {
    const mockFetch = createMockFetch();
    await expect(mockFetch("http://127.0.0.1:8788/v1/unknown")).rejects.toThrow(
      /unexpected http:\/\/127\.0\.0\.1:8788\/v1\/unknown/,
    );
  });
});
