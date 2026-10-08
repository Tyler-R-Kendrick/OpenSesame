/** @vitest-environment jsdom */
/**
 * "Reset this browser?" is on the lock screens where something
 * exists to erase: the unlock form beside a sealed vault. The front
 * door of an empty device carries nothing to reset, so it carries no
 * reset question — the initial state is empty. Opening it leaves the
 * guest road where it was (AGENTS.md §5), and it stands aside while
 * the narrower "Forgotten how to unlock?" panel is open, so only one
 * erase question is on the screen at a time.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import { resetUnlockHarness, v } from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(cleanup);

const question = () =>
  screen.queryByRole("button", { name: "Reset this browser?" });

function fresh() {
  v.state = {
    status: "empty",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
}

function sealed() {
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
}

describe("Reset this browser on the lock screens", () => {
  it("is not on the front door of an empty device", () => {
    fresh();
    render(<UnlockScreen />);
    expect(
      screen.getByRole("button", { name: /^Set up your own/ }),
    ).toBeTruthy();
    // Nothing on an empty device to erase: the reset lives on the
    // unlock form and the vault list, where a vault exists to clear.
    expect(question()).toBeNull();
  });

  it("is on the unlock form, and opening it keeps the guest road", () => {
    sealed();
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Reset this browser?" }),
    );

    expect(
      screen.getByRole("button", { name: "Erase this browser" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Skip to the guest vault" }),
    ).toBeTruthy();
  });

  it("stands aside while the vault's own delete question is open", () => {
    sealed();
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Forgotten how to unlock?" }),
    );
    expect(question()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(question()).toBeTruthy();
  });
});
