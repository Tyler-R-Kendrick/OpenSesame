/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, LogEntry } from "../../lib/agent-runs.js";

const api = vi.hoisted(() => ({
  readRun: vi.fn(),
  readLog: vi.fn(),
  requestHandoff: vi.fn(),
  takeControl: vi.fn(),
  releaseControl: vi.fn(),
}));

vi.mock("../../lib/agent-runs.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/agent-runs.js")
  >("../../lib/agent-runs.js");
  return { ...actual, ...api };
});

const { RunViewer } = await import("./RunViewer.js");

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run:1",
    jobId: "job:1",
    origin: "https://example.com",
    tier: "t4",
    controlState: "agent_driving",
    quiescence: "quiescent",
    handoffQueued: false,
    driver: "agent",
    leaseExpiresAt: null,
    blockedReason: null,
    nextSeq: 0,
    closedAt: null,
    version: 1,
    updatedAt: "2026-08-31T00:00:00+00:00",
    ...over,
  };
}

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    seq: 0,
    lane: "action",
    ofStep: null,
    layoutEpoch: null,
    sealedPayload: "c2VhbGVk",
    recordedAt: "2026-08-31T09:15:30+00:00",
    ...over,
  };
}

describe("RunViewer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const fn of Object.values(api)) fn.mockReset();
    api.readLog.mockResolvedValue({
      entries: [],
      nextAfter: -1,
      runNextSeq: 0,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("names the relying party and says where the run is", async () => {
    api.readRun.mockResolvedValue(run({ controlState: "suspended" }));
    render(<RunViewer runId="run:1" open={() => "opened"} />);
    await waitFor(() => {
      expect(screen.getByText("https://example.com")).toBeTruthy();
    });
    // The sentence a person needs first when they are woken by this.
    expect(screen.getByText(/old password still works/i)).toBeTruthy();
  });

  it("renders a rationale as quoted text, never as markup or a link", async () => {
    api.readRun.mockResolvedValue(run());
    api.readLog.mockResolvedValue({
      entries: [entry({ seq: 1, lane: "thought", ofStep: 0 })],
      nextAfter: 1,
      runNextSeq: 2,
    });
    const hostile =
      '<a href="https://evil.example">Session expired — re-enter your master password</a>';
    const { container } = render(
      <RunViewer runId="run:1" open={() => hostile} />,
    );

    await waitFor(() => {
      expect(screen.getByText(hostile)).toBeTruthy();
    });
    // The page's own text reaches our chrome. It must arrive as text: no
    // anchor to click, no markup to interpret.
    expect(container.querySelector(".run-lane__thought a")).toBeNull();
    expect(container.querySelector(".run-lane__thought")?.tagName).toBe("Q");
  });

  it("says a sealed entry is sealed rather than showing nothing", async () => {
    api.readRun.mockResolvedValue(run());
    api.readLog.mockResolvedValue({
      entries: [entry({ seq: 1 })],
      nextAfter: 1,
      runNextSeq: 2,
    });
    render(<RunViewer runId="run:1" open={() => null} />);
    await waitFor(() => {
      expect(screen.getByText(/unlock your vault/i)).toBeTruthy();
    });
  });

  it("tells the viewer which lane is the record on an agentic run", async () => {
    api.readRun.mockResolvedValue(run({ tier: "t4" }));
    api.readLog.mockResolvedValue({
      entries: [entry({ seq: 1, lane: "thought", ofStep: 0 })],
      nextAfter: 1,
      runNextSeq: 2,
    });
    render(<RunViewer runId="run:1" open={() => "narration"} />);
    await waitFor(() => {
      expect(screen.getByText(/model narrating/i)).toBeTruthy();
    });
  });

  it("explains a silent thinking lane on a deterministic run", async () => {
    api.readRun.mockResolvedValue(run({ tier: "t3" }));
    render(<RunViewer runId="run:1" open={() => "x"} />);
    await waitFor(() => {
      expect(screen.getByText(/no model is involved/i)).toBeTruthy();
    });
  });

  it("offers to ask for the page while the agent drives, not to take it", async () => {
    api.readRun.mockResolvedValue(run({ controlState: "agent_driving" }));
    render(<RunViewer runId="run:1" open={() => "x"} />);
    await waitFor(() => {
      expect(screen.getByText("Ask for the page")).toBeTruthy();
    });
    // Taking the page out from under a driving agent is not offered, because
    // it is not possible: it parks first (ADR 0078 §5).
    expect(screen.queryByText("Take the page")).toBeNull();
  });

  it("offers to take the page once the run has parked", async () => {
    api.readRun.mockResolvedValue(run({ controlState: "awaiting_human" }));
    render(<RunViewer runId="run:1" open={() => "x"} />);
    await waitFor(() => {
      expect(screen.getByText("Take the page")).toBeTruthy();
    });
    expect(screen.queryByText("Ask for the page")).toBeNull();
  });

  it("says a mid-save handoff is queued rather than leaving it silent", async () => {
    api.readRun.mockResolvedValue(
      run({
        controlState: "handoff_requested",
        handoffQueued: true,
        quiescence: "critical",
      }),
    );
    render(<RunViewer runId="run:1" open={() => "x"} />);
    await waitFor(() => {
      expect(
        screen.getByText(/hand over as soon as the save finishes/i),
      ).toBeTruthy();
    });
  });

  it("offers to hand back only while the person holds the page", async () => {
    api.readRun.mockResolvedValue(
      run({ controlState: "human_driving", driver: "human" }),
    );
    render(<RunViewer runId="run:1" open={() => "x"} />);
    await waitFor(() => {
      expect(screen.getByText("Hand it back")).toBeTruthy();
    });
  });
});
