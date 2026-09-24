/** @vitest-environment jsdom */
/** The join ceremony's open road (ADR 0136): ask, and nothing is retired. */
import { JoinError } from "@opensesame/app-core/lib/join/client.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinScreen } from "./JoinScreen.js";
import {
  ENDPOINT,
  fakes,
  installFakes,
  restoreFakes,
} from "./join/join-harness.js";

beforeEach(installFakes);
afterEach(restoreFakes);

describe("the open road", () => {
  async function toSessions() {
    render(
      <JoinScreen captured={null} configured={ENDPOINT} onDone={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(screen.queryByLabelText("Invite")).toBeNull();
    expect(screen.queryByLabelText("Code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify with a passkey" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Design review/ }),
    );
  }

  it("asks with a note, says it is waiting, and retires nothing", async () => {
    await toSessions();
    fireEvent.change(screen.getByLabelText("Note for the operator"), {
      target: { value: "from design" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    await screen.findByRole("heading", { name: "Asked" });
    expect(fakes.askToJoin).toHaveBeenCalledWith(
      ENDPOINT,
      "session:1",
      "from design",
    );
    expect(screen.getByText("waiting on the operator")).toBeTruthy();
    // Nothing has joined yet: the front door is not retired.
    expect(fakes.completeSetup).not.toHaveBeenCalled();
    expect(fakes.endJoinAuthority).toHaveBeenCalled();
  });

  it("retires the front door only when the endpoint admits", async () => {
    fakes.askToJoin.mockResolvedValueOnce({
      id: "r1",
      decision: "admitted",
      mode: "observer",
    });
    await toSessions();
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    await screen.findByRole("heading", { name: "Joined" });
    expect(screen.getByText("admitted, as observer")).toBeTruthy();
    expect(fakes.completeSetup).toHaveBeenCalledWith(
      expect.objectContaining({ joined: true }),
    );
  });

  it("says Join where the session lets anyone in (ADR 0137)", async () => {
    fakes.askToJoin.mockResolvedValueOnce({
      id: "r1",
      decision: "admitted",
      mode: "observer",
    });
    await toSessions();
    // The operator decides this one: an ask, not a join.
    expect(screen.getByRole("button", { name: "Ask to join" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lobby/ }));
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("heading", { name: "Joined" });
    expect(fakes.askToJoin).toHaveBeenCalledWith(ENDPOINT, "session:2", "");
  });

  it("keeps the approval alive while the person chooses, and not after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await toSessions();
      fakes.keepJoinAuthority.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fakes.keepJoinAuthority).toHaveBeenCalledWith(ENDPOINT);
      fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
      await screen.findByRole("heading", { name: "Asked" });
      fakes.keepJoinAuthority.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fakes.keepJoinAuthority).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a failure beside the field it belongs to", async () => {
    fakes.askToJoin.mockRejectedValueOnce(new JoinError("already_asked"));
    await toSessions();
    fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "Your request is already waiting." }),
      ).toBeTruthy(),
    );
  });

  it("reads the list again after starting over", async () => {
    await toSessions();
    expect(fakes.listOpenSessions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    fireEvent.change(screen.getByLabelText("Endpoint"), {
      target: { value: "https://other.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Ask for approval" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Verify with a passkey" }),
    );
    await waitFor(() =>
      expect(fakes.listOpenSessions).toHaveBeenLastCalledWith(
        "https://other.example",
      ),
    );
  });
});
