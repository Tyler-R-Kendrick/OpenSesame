/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  continueAsGuest,
  resetUnlockHarness,
  resumeGuestSession,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(cleanup);

describe("UnlockScreen — guest unlock", () => {
  it("guest Unlock is one commit and the guest road, with no key fields", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: /Passkey|Password|PIN/i }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    // The guest road is load-bearing on the unlock form and is never gated on
    // which vault happens to be locked (AGENTS.md §5) — including here, where
    // the guest tomb is the vault. It starts a fresh guest beside it; the
    // commit below resumes this one.
    expect(
      screen.getByRole("button", { name: "Continue as guest" }),
    ).toBeTruthy();
    const unlock = screen.getByRole("button", { name: "Unlock" });
    fireEvent.click(unlock);
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
  });
});
