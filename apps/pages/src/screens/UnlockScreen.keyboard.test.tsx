import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
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
  resetUnlockHarness,
  setupHolder,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

// Where the keyboard lands on the unlock screen: split from
// UnlockScreen.test.tsx to keep that file inside the module budget.

beforeEach(resetUnlockHarness);

describe("UnlockScreen — where the keyboard lands", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["passkey", "pin", "password"];
    v.preferred = "passkey";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
  });

  afterEach(() => {
    cleanup();
    clearNotices();
  });

  it("lands on the go control for passkey, then follows the method tabs", () => {
    // A returning vault opens on passkey, which has no field: Enter on the go
    // control starts the ceremony. Choosing a typed method moves the caret
    // into its field — no click in the field first.
    render(<UnlockScreen />);
    expect(document.activeElement).toBe(submitButton());
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    fireEvent.click(screen.getByRole("tab", { name: "PIN" }));
    expect(document.activeElement).toBe(screen.getByLabelText("PIN"));
  });

  it("lands on the code mid-MFA", () => {
    v.state.awaitingSecondStep = true;
    render(<UnlockScreen />);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Authenticator code"),
    );
  });

  it("lands on the PIN once 'Use without an account' is chosen with no passkey", () => {
    // The seal form mounts after the sign-in stage on the same screen; the
    // caret has to move into it even though the method never changed.
    v.state.status = "empty";
    setupHolder.current = ANSWERED;
    v.host = { ok: false, reason: "no passkeys here", fixUrl: null };
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use without an account" }),
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Device PIN"));
  });

  it("lands on the acknowledgement when the seal form opens on passkey", () => {
    // Passkey has nothing to type, and the go control refuses until the
    // no-recovery line is accepted — so that checkbox is the first answer.
    v.state.status = "empty";
    setupHolder.current = ANSWERED;
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Use without an account" }),
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
  });

  it("lands on the method tabs when this host cannot do passkeys", () => {
    v.host = { ok: false, reason: "not on a DNS hostname", fixUrl: null };
    render(<UnlockScreen />);
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Passkey" }),
    );
  });

  it("hands the caret back to the field when unlock is refused", async () => {
    v.store.unlock.mockRejectedValue(new Error("wrong"));
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Password" }));
    const field = screen.getByLabelText("Password");
    fireEvent.change(field, { target: { value: "nope" } });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(listNotices().some((n) => n.kind === "status")).toBe(true),
    );
    expect(document.activeElement).toBe(field);
  });
});
