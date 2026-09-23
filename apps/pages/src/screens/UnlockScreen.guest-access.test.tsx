/** @vitest-environment jsdom */
/**
 * Allow guests (Settings › Capabilities). The guest road is on by default,
 * and nothing but this one operator switch may take it off (AGENTS.md §5):
 * off, the unlock footer and both sign-in placements stop offering it; on
 * again, every one of them is back. The default-state tests in
 * `UnlockScreen.guest.test.tsx` and `SignInPanel.test.tsx` stay as they are.
 */
import { setGuestsAllowed } from "@opensesame/app-core/lib/guest-access.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import { resetUnlockHarness, v } from "./unlock-screen-harness.js";
import { SignInPanel } from "./unlock/SignInPanel.js";

beforeEach(resetUnlockHarness);
afterEach(async () => {
  cleanup();
  await setGuestsAllowed(true);
});

const guest = () => screen.queryByRole("button", { name: "Continue as guest" });

describe("Allow guests", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      tomb: "personal",
      header: { unlocks: { password: {} } },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["password"];
    v.preferred = "password";
  });

  it("offers the unlock footer's guest road by default", () => {
    render(<UnlockScreen />);
    expect(guest()).toBeTruthy();
  });

  it("withdraws it when the operator turns guests off, and restores it", async () => {
    await setGuestsAllowed(false);
    render(<UnlockScreen />);
    expect(guest()).toBeNull();
    await act(() => setGuestsAllowed(true));
    expect(guest()).toBeTruthy();
  });

  it("withdraws both sign-in placements and the first-run Skip", async () => {
    await setGuestsAllowed(false);
    render(
      <SignInPanel
        placement="primary"
        providers={[]}
        onUseLocalOnly={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Continue as guest/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toBeNull();
    cleanup();
    render(<SignInPanel placement="secondary" providers={[]} />);
    expect(
      screen.queryByRole("button", { name: /Continue as guest/ }),
    ).toBeNull();
  });
});
