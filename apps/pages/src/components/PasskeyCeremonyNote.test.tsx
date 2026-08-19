import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mfaAppUrl: "",
  support: null as "ok" | "partial" | "missing" | null,
  listeners: [] as Array<() => void>,
}));

vi.mock("../lib/settings.js", () => ({
  loadSettings: () => ({ mfaAppUrl: state.mfaAppUrl }),
  subscribeSettings: (listener: () => void) => {
    state.listeners.push(listener);
    return () => {
      state.listeners = state.listeners.filter((l) => l !== listener);
    };
  },
}));

vi.mock("../lib/webauthn.js", () => ({
  WEBAUTHN_FALLBACK: "This browser cannot do passkeys here.",
  detectWebAuthn: () => Promise.resolve(state.support),
}));

import { PasskeyCeremonyNote } from "./PasskeyCeremonyNote.js";

describe("PasskeyCeremonyNote", () => {
  beforeEach(() => {
    state.mfaAppUrl = "";
    state.support = null;
    state.listeners = [];
  });

  afterEach(cleanup);

  it("stays silent while support is unknown", () => {
    const { container } = render(<PasskeyCeremonyNote />);
    expect(container.firstChild).toBeNull();
  });

  it("stays silent when passkeys fully work", async () => {
    state.support = "ok";
    const { container } = render(<PasskeyCeremonyNote />);
    await waitFor(() => expect(state.listeners.length).toBe(1));
    expect(container.firstChild).toBeNull();
  });

  it("warns and offers the MFA handoff QR when passkeys are missing", async () => {
    state.support = "missing";
    state.mfaAppUrl = "https://mfa.example.com/";
    render(<PasskeyCeremonyNote />);
    expect(
      await screen.findByText("This browser cannot do passkeys here."),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: /Mobile MFA app/ })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open link" });
    expect(link.getAttribute("href")).toBe("https://mfa.example.com/");
  });

  it("points at Settings when no MFA URL is configured", async () => {
    state.support = "partial";
    render(<PasskeyCeremonyNote />);
    expect(
      await screen.findByText(/Set a Mobile MFA URL in Settings/),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reacts to settings changes", async () => {
    state.support = "missing";
    render(<PasskeyCeremonyNote />);
    await screen.findByText(/Set a Mobile MFA URL in Settings/);

    state.mfaAppUrl = "https://mfa.example.com/";
    act(() => {
      for (const listener of state.listeners) listener();
    });
    expect(
      await screen.findByRole("img", { name: /Mobile MFA app/ }),
    ).toBeTruthy();
  });
});
