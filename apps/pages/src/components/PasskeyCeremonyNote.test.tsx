import { overlapCast } from "@opensesame/os-domain";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PasskeyNoteState = {
  mfaAppUrl: string;
  support: "ok" | "missing" | "partial" | null;
  listeners: Array<() => void>;
};

const state = vi.hoisted(() => {
  const bag: PasskeyNoteState = {
    mfaAppUrl: "",
    support: null,
    listeners: [],
  };
  return bag;
});

import { settingsSeams } from "../lib/settings.js";
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {
  loadSettings: () => ({ mfaAppUrl: state.mfaAppUrl }),
  subscribeSettings: (listener: () => void) => {
    state.listeners.push(listener);
    return () => {
      state.listeners = state.listeners.filter((l) => l !== listener);
    };
  },
});
import { webauthnSeams } from "../lib/webauthn.js";
const originalWebauthnSeams = { ...webauthnSeams };
Object.assign(webauthnSeams, {
  WEBAUTHN_FALLBACK: "This browser cannot do passkeys here.",
  detectWebAuthn: () => Promise.resolve(state.support),
});

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

  it("offers the MFA URL field in place when none is configured", async () => {
    // This used to be a sentence pointing at Settings — a dead end with
    // nothing to click. Setting the URL is one field, so it happens here.
    state.support = "partial";
    render(<PasskeyCeremonyNote />);
    expect(await screen.findByLabelText("Mobile MFA app URL")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reacts to settings changes", async () => {
    state.support = "missing";
    render(<PasskeyCeremonyNote />);
    await screen.findByLabelText("Mobile MFA app URL");

    state.mfaAppUrl = "https://mfa.example.com/";
    act(() => {
      for (const listener of state.listeners) listener();
    });
    expect(
      await screen.findByRole("img", { name: /Mobile MFA app/ }),
    ).toBeTruthy();
  });
});
