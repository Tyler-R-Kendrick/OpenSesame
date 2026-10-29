import { describe, expect, it, vi } from "vitest";
import { toastOf } from "../notice-toast.js";
import {
  clearNotices,
  listNotices,
  subscribeNoticeArrivals,
} from "../notices.js";
import { type AgentRunView, syncResetRunNotices } from "./run-notice-bridge.js";
import {
  clearVaultResetRunsForTest,
  setVaultResetRunPhase,
  vaultResetRunFor,
} from "./vault-run-tracker.js";

function trackedRun() {
  clearVaultResetRunsForTest();
  clearNotices();
  setVaultResetRunPhase(
    "personal",
    "item-1",
    "in-progress",
    null,
    new Date(),
    "job-1",
  );
}

function deps(runs: AgentRunView[], jobStatus = "requested") {
  return {
    listAgentRuns: vi.fn(async () => runs),
    getRotationJob: vi.fn(async () => ({ id: "job-1", status: jobStatus })),
  };
}

describe("reset run notice bridge", () => {
  it("parked run lands in the notifications queue and rings a toast arrival", async () => {
    trackedRun();
    const arrivals: string[] = [];
    const off = subscribeNoticeArrivals((notice) => {
      arrivals.push(notice.id);
      expect(toastOf(notice).open).toEqual({
        to: "/runs/run-9",
        label: "Take over",
      });
    });
    await syncResetRunNotices(
      deps([
        {
          id: "run-9",
          job_id: "job-1",
          control_state: "awaiting_human",
          blocked_reason: "captcha",
        },
      ]),
    );
    off();
    expect(arrivals).toEqual(["agent-run:run-9"]);
    const notice = listNotices().find((n) => n.id === "agent-run:run-9");
    expect(notice?.tone).toBe("warn");
    expect(notice?.title).toBe("Password reset needs you");
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("needs-you");
    expect(vaultResetRunFor("personal", "item-1")?.runId).toBe("job-1");
  });

  it("does not duplicate the notice on repeated polls", async () => {
    trackedRun();
    const parked = deps([
      { id: "run-9", job_id: "job-1", control_state: "awaiting_human" },
    ]);
    await syncResetRunNotices(parked);
    await syncResetRunNotices(parked);
    expect(
      listNotices().filter((n) => n.id === "agent-run:run-9"),
    ).toHaveLength(1);
  });

  it("dismisses the notice and returns to in-progress when the agent resumes", async () => {
    trackedRun();
    await syncResetRunNotices(
      deps([{ id: "run-9", job_id: "job-1", control_state: "awaiting_human" }]),
    );
    await syncResetRunNotices(
      deps([{ id: "run-9", job_id: "job-1", control_state: "agent_driving" }]),
    );
    expect(
      listNotices().find((n) => n.id === "agent-run:run-9"),
    ).toBeUndefined();
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("in-progress");
  });

  it("marks done only when the rotation job itself succeeded", async () => {
    trackedRun();
    await syncResetRunNotices(deps([], "succeeded"));
    expect(vaultResetRunFor("personal", "item-1")).toBeNull();
  });

  it("marks failed and announces it once", async () => {
    trackedRun();
    await syncResetRunNotices(deps([], "failed"));
    await syncResetRunNotices(deps([], "failed"));
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("failed");
    const failures = listNotices().filter(
      (notice) => notice.id === "password-reset:job-1:failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.tone).toBe("err");
  });

  it("settles a closed suspended run from its terminal job", async () => {
    trackedRun();
    await syncResetRunNotices(
      deps(
        [
          {
            id: "run-9",
            job_id: "job-1",
            control_state: "suspended",
            closed_at: "2026-10-28T00:00:00Z",
          },
        ],
        "failed",
      ),
    );
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("failed");
    expect(
      listNotices().some((notice) => notice.id === "agent-run:run-9"),
    ).toBe(false);
  });

  it("stays in-progress while the job is requested and no agent run exists yet", async () => {
    trackedRun();
    await syncResetRunNotices(deps([], "requested"));
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("in-progress");
    expect(listNotices()).toHaveLength(0);
  });

  it("tolerates the Host being unreachable", async () => {
    trackedRun();
    await syncResetRunNotices({
      listAgentRuns: vi.fn(async () => {
        throw new Error("offline");
      }),
      getRotationJob: vi.fn(async () => null),
    });
    expect(vaultResetRunFor("personal", "item-1")?.phase).toBe("in-progress");
  });
});
