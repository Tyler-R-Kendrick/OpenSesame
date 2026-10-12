/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { PrfCeremonyError } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-output.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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

  function sealOnce() {
    fireEvent.click(submitButton());
  }

  it("steps past an authenticator that cannot answer PRF without an error", async () => {
    v.store.createWithPasskey.mockRejectedValue(
      new PrfCeremonyError("prf_missing_output", "no PRF"),
    );
    render(<UnlockScreen />);
    goLocalOnly();
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    sealOnce();
    // This device could not seal: the form is on Security key, ready to go again.
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Security key" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(document.querySelector(".status-mark")).toBeNull();
    const ids = listNotices().map((entry) => entry.id);
    expect(ids).not.toContain("unlock:error");
    const note = listNotices().find((n) => n.id === "unlock:authenticator");
    expect(note?.tone).toBe("info");
    expect(note?.body).toMatch(/Security key is selected/);

    // The key cannot either: the form is on the PIN road.
    sealOnce();
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "PIN" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(v.store.createWithPasskey).toHaveBeenLastCalledWith(
      expect.any(AbortSignal),
      { attachment: "cross-platform" },
    );
    expect(listNotices().map((entry) => entry.id)).not.toContain(
      "unlock:error",
    );
    expect(
      listNotices().find((n) => n.id === "unlock:authenticator")?.body,
    ).toMatch(/PIN instead/);
  });

  it("does not offer a passkey where the browser has no PRF at all", async () => {
    vi.stubGlobal(
      "PublicKeyCredential",
      Object.assign(function PublicKeyCredential() {}, {
        getClientCapabilities: async () => ({ "extension:prf": false }),
      }),
    );
    render(<UnlockScreen />);
    goLocalOnly();
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull(),
    );
    expect(
      screen.getByRole("tab", { name: "PIN" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tablist", { name: "Passkey on" })).toBeNull();
  });
});
