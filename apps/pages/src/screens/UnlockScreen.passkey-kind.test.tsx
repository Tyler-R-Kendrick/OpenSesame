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
  ANSWERED,
  chooseSealMethod,
  goLocalOnly,
  resetUnlockHarness,
  setupHolder,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);

/**
 * Sealing a new vault names where its passkey lives: a PC that offers Windows
 * Hello first never reaches a security key plugged in beside it.
 */
describe("UnlockScreen — first run, which authenticator", () => {
  beforeEach(() => {
    setupHolder.current = ANSWERED;
    v.state = {
      status: "empty",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["password"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.createWithPasskey.mockResolvedValue(undefined);
    v.store.createWithPin.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("seals on this device unless a security key is chosen", async () => {
    render(<UnlockScreen />);
    goLocalOnly();
    const kinds = screen.getByRole("tablist", { name: "Passkey on" });
    expect(kinds.querySelector("[aria-selected=true]")?.textContent).toBe(
      "This device",
    );
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPasskey).toHaveBeenCalledTimes(1),
    );
    expect(v.store.createWithPasskey).toHaveBeenLastCalledWith(
      expect.any(AbortSignal),
      { attachment: "platform" },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Security key" }));
    expect(
      screen
        .getByRole("tab", { name: "Security key" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.createWithPasskey).toHaveBeenCalledTimes(2),
    );
    expect(v.store.createWithPasskey).toHaveBeenLastCalledWith(
      expect.any(AbortSignal),
      { attachment: "cross-platform" },
    );
  });

  it("asks which authenticator only while sealing with a passkey", () => {
    render(<UnlockScreen />);
    goLocalOnly();
    expect(screen.getByRole("tablist", { name: "Passkey on" })).toBeTruthy();
    chooseSealMethod("PIN");
    expect(screen.queryByRole("tablist", { name: "Passkey on" })).toBeNull();
  });
});
