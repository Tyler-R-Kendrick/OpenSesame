/** @vitest-environment jsdom */
import {
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, NavLink, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TakeoverPanel } from "./TakeoverPanel.js";
import type { TakeoverClient } from "./takeover-client.js";

afterEach(() => {
  cleanup();
  dismissNotice("takeover-run-9");
  dismissNotice("takeover-run-10");
  vi.useRealTimers();
});

function fakeClient(initialControl: string) {
  const state = { control: initialControl };
  const run = (id = "run-9") => ({
    id,
    job_id: "job-1",
    origin: "https://mail.example.test",
    control_state: state.control,
    driver: state.control === "human_driving" ? "human" : "agent",
    blocked_reason: "captcha",
    closed_at: null,
  });
  const client = {
    authenticate: vi.fn(async () => {}),
    getRun: vi.fn(async (id: string) => run(id)),
    listHookRecords: vi.fn(async () => []),
    requestHandoff: vi.fn(async () => run()),
    takeControl: vi.fn(async () => {
      state.control = "human_driving";
      return run();
    }),
    release: vi.fn(async () => {
      state.control = "resume_requested";
      return run();
    }),
    claimStep: vi.fn(async () => ({
      run_id: "run-9",
      seq: 4,
      request: { step: "submit", selector: "#save" },
    })),
    settleStep: vi.fn(async () => {}),
  } as unknown as TakeoverClient & {
    authenticate: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    requestHandoff: ReturnType<typeof vi.fn>;
    takeControl: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    claimStep: ReturnType<typeof vi.fn>;
    settleStep: ReturnType<typeof vi.fn>;
  };
  return client;
}

function renderPanel(client: TakeoverClient) {
  return render(
    <MemoryRouter initialEntries={["/runs/run-9"]}>
      <NavLink to="/runs/run-10">Next run</NavLink>
      <Routes>
        <Route
          path="/runs/:runId"
          element={<TakeoverPanel client={client} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TakeoverPanel", () => {
  it("takes over a parked run, answers its step, and hands back", async () => {
    const client = fakeClient("awaiting_human");
    renderPanel(client);
    await screen.findByText(/Parked — waiting for you/u);
    const verify = await screen.findByRole("button", {
      name: "Verify to control",
    });
    fireEvent.click(verify);
    await waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    const take = await screen.findByRole("button", { name: "Take over" });
    fireEvent.click(take);
    await waitFor(() =>
      expect(client.takeControl).toHaveBeenCalledWith("run-9"),
    );
    const check = await screen.findByRole("button", {
      name: "Check for a step",
    });
    fireEvent.click(check);
    const done = await screen.findByRole("button", { name: "I did this" });
    fireEvent.click(done);
    await waitFor(() =>
      expect(client.settleStep).toHaveBeenCalledWith("run-9", 4, {
        outcome: "done",
      }),
    );
    const release = await screen.findByRole("button", {
      name: "Hand back & resume",
    });
    fireEvent.click(release);
    await waitFor(() => expect(client.release).toHaveBeenCalledWith("run-9"));
  });

  it("shows no controls for a closed run", async () => {
    const client = fakeClient("agent_driving");
    client.getRun.mockResolvedValue({
      id: "run-9",
      control_state: "agent_driving",
      closed_at: "2026-10-28T00:00:00Z",
    });
    renderPanel(client);
    await screen.findByText(/The agent is driving/u);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps an action failure through an unrelated successful poll", async () => {
    vi.useFakeTimers();
    const client = fakeClient("agent_driving");
    client.requestHandoff.mockRejectedValueOnce(
      new Error("The Host refused handoff."),
    );
    renderPanel(client);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Verify to control" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Request handoff" }));
    await act(async () => {});
    expect(
      listNotices().find((notice) => notice.id === "takeover-run-9")?.body,
    ).toBe("The Host refused handoff.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(
      listNotices().find((notice) => notice.id === "takeover-run-9")?.body,
    ).toBe("The Host refused handoff.");
  });

  it("offers browser verification before the run has loaded", async () => {
    let authenticated = false;
    const client = fakeClient("awaiting_human");
    client.authenticate.mockImplementation(async () => {
      authenticated = true;
    });
    client.getRun.mockImplementation(async (id: string) => {
      if (!authenticated) throw new Error("not_found");
      return {
        id,
        control_state: "awaiting_human",
        origin: "https://mail.example.test",
        closed_at: null,
      };
    });
    renderPanel(client);
    const verify = await screen.findByRole("button", {
      name: "Verify to control",
    });
    fireEvent.click(verify);
    await waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: "Take over" }),
    ).toBeTruthy();
  });

  it("reacquires an expired step claim without reloading", async () => {
    const client = fakeClient("human_driving");
    const claimStep = client.claimStep;
    claimStep
      .mockResolvedValueOnce({
        run_id: "run-9",
        seq: 4,
        request: { step: "submit", selector: "#save" },
        claim_expires_at: "2000-01-01T00:00:00Z",
      })
      .mockResolvedValueOnce({
        run_id: "run-9",
        seq: 4,
        request: { step: "submit", selector: "#save" },
        claim_expires_at: "2999-01-01T00:00:00Z",
      });
    renderPanel(client);
    await screen.findByText(/You are driving/u);
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify to control" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Check for a step" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reacquire step" }),
    );
    await waitFor(() => expect(claimStep).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "I did this" }));
    await waitFor(() =>
      expect(client.settleStep).toHaveBeenCalledWith("run-9", 4, {
        outcome: "done",
      }),
    );
  });

  it("clears the previous run before loading a new route", async () => {
    const client = fakeClient("awaiting_human");
    client.getRun.mockImplementation(async (id: string) => {
      if (id === "run-10") await new Promise(() => {});
      return {
        id,
        control_state: "awaiting_human",
        origin: `https://${id}.example.test`,
        closed_at: null,
      };
    });
    renderPanel(client);
    await screen.findByText(/run-9.example.test/u);
    fireEvent.click(screen.getByRole("link", { name: "Next run" }));
    await waitFor(() => expect(client.getRun).toHaveBeenCalledWith("run-10"));
    expect(screen.queryByText(/run-9.example.test/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});
