import { describe, expect, it, vi } from "vitest";
import {
  createTakeoverClient,
  expectedOutcome,
  takeoverActions,
} from "./takeover-client.js";

const RUN = {
  id: "run-9",
  job_id: "job-1",
  origin: "https://mail.example.test",
  control_state: "awaiting_human",
  driver: "agent",
  blocked_reason: "captcha",
  closed_at: null,
};

function client(overrides = {}) {
  const post = vi.fn(async () => ({
    status: 200,
    json: async () => ({ ...RUN, control_state: "human_driving" }),
  }));
  const get = vi.fn(async () => ({ status: 200, json: async () => RUN }));
  const authenticate = vi.fn(async () => {});
  const authorize = vi.fn(async () => "e".repeat(64));
  return {
    api: createTakeoverClient({
      get,
      post,
      authenticate,
      authorize,
      ...overrides,
    }),
    get,
    post,
    authenticate,
    authorize,
  };
}

describe("takeover client", () => {
  it("offers take-over only while parked, release+claim while driving", () => {
    expect(takeoverActions(RUN)).toEqual(["take"]);
    expect(takeoverActions({ ...RUN, control_state: "human_driving" })).toEqual(
      ["release", "claim"],
    );
    expect(takeoverActions({ ...RUN, control_state: "agent_driving" })).toEqual(
      ["handoff"],
    );
    expect(
      takeoverActions({ ...RUN, control_state: "resume_requested" }),
    ).toEqual([]);
    expect(
      takeoverActions({ ...RUN, control_state: "handoff_requested" }),
    ).toEqual([]);
    expect(
      takeoverActions({ ...RUN, closed_at: "2026-10-28T00:00:00Z" }),
    ).toEqual([]);
  });

  it("take control step-up authorizes then posts the elevation", async () => {
    const { api, post, authorize } = client();
    const run = await api.takeControl("run-9");
    expect(authorize).toHaveBeenCalledWith("take", "run-9");
    expect(post).toHaveBeenCalledWith("/api/v1/agent/runs/run-9/control", {
      elevation: "e".repeat(64),
    });
    expect(run.control_state).toBe("human_driving");
  });

  it("release hands the page back for resume", async () => {
    const { api, post, authorize } = client();
    await api.release("run-9");
    expect(authorize).toHaveBeenCalledWith("release", "run-9");
    expect(post).toHaveBeenCalledWith("/api/v1/agent/runs/run-9/release", {
      elevation: "e".repeat(64),
    });
  });

  it("claims a step and settles only outcomes the panel can truthfully report", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          run_id: "run-9",
          seq: 4,
          request: { step: "submit", selector: "#save" },
        }),
      })
      .mockResolvedValue({ status: 200, json: async () => ({}) });
    const { api } = client({ post });
    const step = await api.claimStep("run-9");
    expect(step?.seq).toBe(4);
    expect(expectedOutcome("submit")).toBe("done");
    await api.settleStep("run-9", 4, { outcome: "done" });
    expect(post).toHaveBeenLastCalledWith(
      "/api/v1/agent/runs/run-9/steps/4/outcome",
      { outcome: { outcome: "done" } },
    );
    await expect(
      api.settleStep("run-9", 4, { outcome: "dom", text: "x" } as never),
    ).rejects.toThrow(/cannot report/u);
  });

  it("claim returns null on 204", async () => {
    const { api } = client({
      post: vi.fn(async () => ({ status: 204, json: async () => null })),
    });
    expect(await api.claimStep("run-9")).toBeNull();
  });

  it("keeps browser authentication on a separate gesture from elevation", async () => {
    const calls: string[] = [];
    const authenticate = vi.fn(async () => {
      calls.push("authenticate");
    });
    const authorize = vi.fn(async () => {
      calls.push("authorize");
      return "e".repeat(64);
    });
    const { api } = client({ authenticate, authorize });
    await api.authenticate();
    expect(calls).toEqual(["authenticate"]);
    await api.takeControl("run-9");
    expect(calls).toEqual(["authenticate", "authorize"]);
  });

  it("follows every hook-record cursor", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          records: [{ sequence: 1 }],
          next_after: 1,
          has_more: true,
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          records: [{ sequence: 2 }],
          next_after: 2,
          has_more: false,
        }),
      });
    const { api } = client({ get });
    expect(
      (await api.listHookRecords("run-9")).map((row) => row.sequence),
    ).toEqual([1, 2]);
    expect(get).toHaveBeenLastCalledWith(
      "/api/v1/agent/runs/run-9/hook-records?limit=20&after=1",
    );
  });
});
