import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  RunnerApiError,
  createApiClient,
  decodeAgentRun,
  decodeRunnerStepRequest,
} from "./index.js";

const run = {
  id: "run:1",
  job_id: "job:1",
  origin: "https://rp.example",
  tier: "t3",
  control_state: "agent_driving",
  quiescence: "quiescent",
  handoff_queued: false,
  driver: "agent",
  lease_expires_at: null,
  blocked_reason: null,
  next_seq: 0,
  expires_at: "2026-10-03T12:00:00Z",
  closed_at: null,
  version: 1,
  created_at: "2026-10-03T11:00:00Z",
  updated_at: "2026-10-03T11:00:00Z",
  secrets_returned: false,
  observation_included: false,
};

function harness(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const client = createApiClient({
    baseUrl: "https://host.test:8787",
    accessToken: "token",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      });
      return handler(String(input), init);
    },
  });
  return { client, calls };
}

const json = (body: BoundaryValue, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("api-client agent runs", () => {
  it("lists the caller's runs and drops rows that are not runs", async () => {
    const { client, calls } = harness(() =>
      json({ runs: [run, { id: "x" }, 7], secrets_returned: false }),
    );
    const runs = await client.listAgentRuns();
    expect(runs.map((r) => r.id)).toEqual(["run:1"]);
    expect(calls[0]).toMatchObject({
      url: "https://host.test:8787/api/v1/agent/runs",
      method: "GET",
    });
  });

  it("reads one run, encoding the id into the path", async () => {
    const { client, calls } = harness(() => json({ ...run, id: "run/1" }));
    expect((await client.getAgentRun("run/1")).origin).toBe(
      "https://rp.example",
    );
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/agent/runs/run%2F1",
    );
  });

  it("refuses a body whose id is not the run that was requested", async () => {
    const { client } = harness(() => json(run));
    await expect(client.getAgentRun("run:other")).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("claim: a 204 is nothing to do, not an error", async () => {
    const { client, calls } = harness(
      () => new Response(null, { status: 204 }),
    );
    await expect(client.claimRunnerStep("run:1")).resolves.toBeNull();
    expect(calls[0]).toMatchObject({
      url: "https://host.test:8787/api/v1/agent/runs/run%3A1/steps/claim",
      method: "POST",
    });
  });

  it("claim: returns the raw request beside its seq", async () => {
    const { client } = harness(() =>
      json({
        run_id: "run:1",
        seq: 3,
        request: { step: "wait_for", selector: "#pw" },
        claim_expires_at: "2026-10-03T11:01:00Z",
        secrets_returned: false,
      }),
    );
    await expect(client.claimRunnerStep("run:1")).resolves.toEqual({
      run_id: "run:1",
      seq: 3,
      request: { step: "wait_for", selector: "#pw" },
      claim_expires_at: "2026-10-03T11:01:00Z",
    });
  });

  it("claim: a response that does not say no secrets is refused", async () => {
    for (const body of [
      { run_id: "run:1", seq: 0, request: {}, secrets_returned: true },
      { run_id: "run:1", seq: 0, request: {} },
      { run_id: "run:2", seq: 0, request: {}, secrets_returned: false },
      { run_id: "run:1", seq: -1, request: {}, secrets_returned: false },
      { run_id: "run:1", seq: 0, request: "x", secrets_returned: false },
    ]) {
      const { client } = harness(() => json(body));
      await expect(client.claimRunnerStep("run:1")).rejects.toMatchObject({
        code: "unexpected_response",
      });
    }
  });

  it("settle: posts exactly the outcome and reads the receipt", async () => {
    const { client, calls } = harness(() =>
      json({ status: "settled", redacted: true, refused: false }),
    );
    const receipt = await client.settleRunnerStep("run:1", 4, {
      outcome: "sealed",
      backed_up: true,
    });
    expect(receipt).toEqual({
      status: "settled",
      redacted: true,
      refused: false,
    });
    expect(calls[0]).toMatchObject({
      url: "https://host.test:8787/api/v1/agent/runs/run%3A1/steps/4/outcome",
      method: "POST",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      outcome: { outcome: "sealed", backed_up: true },
    });
  });

  it("settle: a refusal carries status and code and nothing the driver sent", async () => {
    for (const [status, code] of [
      [409, "not_the_claimant"],
      [422, "invalid_outcome"],
      [413, "outcome_too_large"],
    ] as const) {
      const { client } = harness(() =>
        json({ error: code, hint: "x" }, status),
      );
      const settling = client.settleRunnerStep("run:1", 0, {
        outcome: "done",
      });
      await expect(settling).rejects.toBeInstanceOf(RunnerApiError);
      await expect(settling).rejects.toMatchObject({
        status,
        code,
        message: `runner_step_settle_failed:${status}:${code}`,
      });
    }
  });

  it("hook records: pages by cursor and limit", async () => {
    const { client, calls } = harness(() => json({ records: [] }));
    await client.readRunHookRecords("run:1", { after: 4, limit: 8 });
    await client.readRunHookRecords("run:1");
    expect(calls[0]?.url).toBe(
      "https://host.test:8787/api/v1/agent/runs/run%3A1/hook-records?after=4&limit=8",
    );
    expect(calls[1]?.url).toBe(
      "https://host.test:8787/api/v1/agent/runs/run%3A1/hook-records",
    );
  });
});

describe("decodeRunnerStepRequest", () => {
  const good: BoundaryValue[] = [
    { step: "navigate", url: "https://rp.example/change" },
    { step: "wait_for", selector: "#new" },
    { step: "fill_credential", reference: "current_password", selector: "#c" },
    { step: "assert_present", reference: "candidate:1", selector: "#n" },
    { step: "submit", selector: "button" },
    { step: "read_dom_redacted", strip: ["#a", "#b"] },
    { step: "screenshot_redacted", epoch: 2, mask_selectors: ["#a"] },
    { step: "verify_login", reference: "candidate:1" },
    {
      step: "capture_credential",
      slot: "app_id",
      selector: "#i",
      recipient: "r",
    },
    {
      step: "capture_download",
      slot: "private_key",
      content_type: "x",
      recipient: "r",
    },
    { step: "generate_candidate", handle: "candidate:1" },
    { step: "seal_candidate", handle: "candidate:1" },
    { step: "promote_candidate", handle: "candidate:1" },
  ];

  it("decodes every step the Host can queue", () => {
    for (const request of good) {
      expect(decodeRunnerStepRequest(request)).toEqual(request);
    }
  });

  it("refuses an unknown tag, a missing field, a wrong type and an extra field", () => {
    const bad: BoundaryValue[] = [
      { step: "teleport" },
      { step: "navigate" },
      { step: "navigate", url: 3 },
      { step: "navigate", url: "https://x", password: "p" },
      { step: "wait_for", selector: "#a", reference: "r" },
      { step: "read_dom_redacted", strip: "#a" },
      { step: "read_dom_redacted", strip: [1] },
      { step: "read_dom_redacted", strip: [], extra: 1 },
      { step: "screenshot_redacted", epoch: -1, mask_selectors: [] },
      { step: "screenshot_redacted", epoch: 1.5, mask_selectors: [] },
      { step: "screenshot_redacted", epoch: 1, mask_selectors: [3] },
      { step: 3 },
      "navigate",
      null,
      [],
    ];
    for (const request of bad) {
      expect(
        decodeRunnerStepRequest(request),
        JSON.stringify(request),
      ).toBeNull();
    }
  });

  it("decodeAgentRun refuses a state it does not know", () => {
    expect(decodeAgentRun({ ...run, control_state: "autonomous" })).toBeNull();
    expect(decodeAgentRun(run)?.driver).toBe("agent");
    expect(decodeAgentRun({ ...run, driver: "human" })?.driver).toBe("human");
  });
});
