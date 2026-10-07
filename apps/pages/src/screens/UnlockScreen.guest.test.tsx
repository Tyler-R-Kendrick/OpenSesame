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
  it("guest Unlock is one commit on a keyless guest tomb, with no key fields", async () => {
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
    // Unlock resumes this tomb. A second "Skip to the guest vault" beside it
    // would duplicate guest access (AGENTS.md §5), so the footer link stays off.
    expect(
      screen.queryByRole("button", { name: "Skip to the guest vault" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    const unlock = screen.getByRole("button", { name: "Unlock" });
    fireEvent.click(unlock);
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
  });
});
