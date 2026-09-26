/** @vitest-environment jsdom */
/**
 * `/guest` (ADR 0140 D12): the alias opens the guest road that is already
 * on the screen and lands the keyboard on it — on the front door's sign-in
 * panel and on the unlock form's footer alike. It points, never presses, and
 * it cannot bring back a road the operator's "Allow guests" switch took away
 * (ADR 0135): with guests off the link opens the ordinary screen, and the
 * screen's own landing stands.
 */
import {
  noteGuestArrival,
  peekGuestArrival,
  resetAliasArrivalForTests,
} from "@opensesame/app-core/lib/ceremony-aliases.js";
import { setGuestsAllowed } from "@opensesame/app-core/lib/guest-access.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import { resetUnlockHarness, v } from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(async () => {
  cleanup();
  resetAliasArrivalForTests();
  await setGuestsAllowed(true);
});

const guest = () => screen.queryByRole("button", { name: "Continue as guest" });

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

describe("/guest lands on the guest road", () => {
  it("takes the keyboard to the unlock form's guest road beside a sealed vault", async () => {
    sealed();
    noteGuestArrival();
    render(<UnlockScreen />);
    const road = guest();
    expect(road).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(road));
    // Pointed at, not pressed: nothing was created.
    expect(v.store.create).not.toHaveBeenCalled();
    expect(peekGuestArrival()).toBe(false);
  });

  it("takes the keyboard to the front door's guest button", async () => {
    fresh();
    noteGuestArrival();
    render(<UnlockScreen />);
    const road = guest();
    expect(road).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(road));
  });

  it("leaves the screen's own landing alone without a /guest arrival", async () => {
    sealed();
    render(<UnlockScreen />);
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    expect(document.activeElement).not.toBe(guest());
  });

  it("opens the ordinary screen when the operator turned guests off", async () => {
    await setGuestsAllowed(false);
    sealed();
    noteGuestArrival();
    render(<UnlockScreen />);
    expect(guest()).toBeNull();
    // The arrival is spent, so it cannot surface later on some other screen.
    await waitFor(() => expect(peekGuestArrival()).toBe(false));
    expect(document.activeElement?.textContent ?? "").not.toMatch(/guest/i);
  });
});
