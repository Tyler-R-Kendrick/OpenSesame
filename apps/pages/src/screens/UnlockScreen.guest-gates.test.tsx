/** @vitest-environment jsdom */
/**
 * The guest tomb's unlock screen (ADR 0091, AGENTS.md §5): a guest may enroll
 * a PIN and an authenticator code, so the guest tomb is isolated, not keyless.
 * Its locked screen shows exactly the challenges its header enrolled and the
 * guest road beside them — neither is suppressed because "this one is the
 * guest tomb". Suppressing them both locked the guest out of their own vault
 * behind an inert Unlock button and dropped a load-bearing guest entry.
 */
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
  resetUnlockHarness,
  resumeGuestSession,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(cleanup);

describe("UnlockScreen — the guest tomb's own gate", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      tomb: "guest",
      header: { unlocks: { pin: {}, totp: {} } },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["pin"];
    v.preferred = "pin";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.unlockWithPin.mockResolvedValue(undefined);
  });

  it("opens with the gate it enrolled, guest still on offer", async () => {
    render(<UnlockScreen />);
    expect(screen.getByRole("tab", { name: "PIN" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Password" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull();
    expect(screen.getByText("1 · Key")).toBeTruthy();
    expect(screen.getByText("2 · Authenticator code")).toBeTruthy();
    expect(screen.getByLabelText("PIN")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue as guest" }),
    ).toBeTruthy();

    // The key it enrolled is the road in — not a guest resume that would walk
    // straight past the gate the guest asked for.
    fireEvent.change(screen.getByLabelText("PIN"), {
      target: { value: "246810" },
    });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPin).toHaveBeenCalledWith("246810"),
    );
    expect(resumeGuestSession).not.toHaveBeenCalled();
  });

  it("still takes the guest road when there is no key at all", async () => {
    v.state = { ...v.state, header: null };
    v.methods = [];
    render(<UnlockScreen />);
    expect(screen.queryByRole("tab", { name: "PIN" })).toBeNull();
    expect(screen.queryByLabelText("PIN")).toBeNull();
    // No field for a method this vault never enrolled either: the fallback
    // method resolves to "password", and a Password field with no password wrap
    // could only fail.
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(submitButton());
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(v.store.unlockWithPin).not.toHaveBeenCalled();
  });
});
