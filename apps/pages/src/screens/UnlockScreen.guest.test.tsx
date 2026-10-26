/** @vitest-environment jsdom */
import { guestVaultLabel } from "@opensesame/app-core/lib/local-guest.js";
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
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
  continueAsGuest,
  openSignIn,
  resetUnlockHarness,
  resumeGuestSession,
  userMenuTrigger,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("opens saved sign-in choices from a keyless guest and returns to Unlock", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    const settings = settingsSeams.loadSettings();
    vi.spyOn(settingsSeams, "loadSettings").mockReturnValue({
      ...settings,
      signIn: {
        builtin: false,
        providers: [
          {
            providerId: "byo-identity",
            issuer: "https://identity.example.test",
            clientId: "guest-browser-client",
            label: "Saved BYO Identity",
            connectionId: "idc_guest_browser",
            protocol: "oidc",
          },
        ],
      },
    });
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Saved BYO Identity",
      }),
    ).toBeNull();

    openSignIn();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with Saved BYO Identity" }),
    ).toBeTruthy();
    expect(document.querySelector(".unlock__form")).toBeNull();
    expect(resumeGuestSession).not.toHaveBeenCalled();
    expect(v.store.unlock).not.toHaveBeenCalled();

    fireEvent.click(userMenuTrigger());
    fireEvent.click(screen.getByRole("menuitem", { name: guestVaultLabel() }));
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Saved BYO Identity",
      }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    expect(resumeGuestSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
    expect(v.store.unlock).not.toHaveBeenCalled();
  });
});
