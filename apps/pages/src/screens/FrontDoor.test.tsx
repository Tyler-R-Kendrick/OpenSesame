import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { federationSeams } from "../lib/federation.js";
import { guestAuthSeams } from "../lib/guest-auth.js";
import { identitySeams } from "../lib/identity.js";
import type { PagesSettings } from "../lib/settings.js";
import { defaultSignInMethods, settingsSeams } from "../lib/settings.js";

/**
 * The front door (ADR 0115): the two roads made large, with every sign-in
 * road still whole beneath them. Its contract is the arrival — what is on
 * the screen, in which order, and where the keyboard lands — because the
 * roads themselves only open ceremonies other suites cover.
 */

const state = { identityApi: "" };
const originalSettingsSeams = { ...settingsSeams };
Object.assign(settingsSeams, {
  loadSettings: (): PagesSettings => ({
    ...originalSettingsSeams.loadSettings(),
    identityApi: state.identityApi,
    signIn: defaultSignInMethods(),
  }),
});
Object.assign(identitySeams, {
  identityBase: () => state.identityApi,
  useIdentitySession: () => null,
});
Object.assign(federationSeams, {
  beginSignIn: vi.fn(() => new Promise<void>(() => {})),
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google",
  }),
  loadSession: () => null,
});
const continueAsGuest = vi.fn<() => Promise<void>>();
Object.assign(guestAuthSeams, { continueAsGuest });

import { FrontDoor } from "./FrontDoor.js";

function renderDoor(overrides: Partial<Parameters<typeof FrontDoor>[0]> = {}) {
  const props = {
    providers: [],
    onOpenJoin: vi.fn(),
    onOpenSetup: vi.fn(),
    onUseLocalOnly: vi.fn(),
    ...overrides,
  };
  render(<FrontDoor {...props} />);
  return props;
}

beforeEach(() => {
  state.identityApi = "";
  continueAsGuest.mockReset();
  continueAsGuest.mockResolvedValue(undefined);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(cleanup);

describe("the front door", () => {
  it("titles the screen with the wordmark and offers the two roads before sign-in", () => {
    renderDoor();
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(document.querySelector("h1.wordmark .wordmark__slots")).toBeTruthy();
    const names = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    // Document order is Tab order: the roads, then the corner skip, then the
    // brand marks, guest, and the local-only seal.
    expect(names.slice(0, 2)).toEqual(["Join a session", "Set up your own"]);
    expect(
      screen
        .getByRole("button", { name: "Join a session" })
        .getAttribute("aria-describedby"),
    ).toBe("door-join-kind");
    expect(screen.getByText("a link and a code").id).toBe("door-join-kind");
    expect(names).toContain("Skip sign-in and continue as guest");
    expect(names).toContain("Continue with Google");
    expect(names).toContain("Continue as guest");
    expect(names[names.length - 1]).toBe("Use without an account");
    expect(screen.getByText("or sign in")).toBeTruthy();
  });

  it("lands the keyboard on the first road", () => {
    renderDoor();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Join a session" }),
    );
  });

  it("yields the landing to the identifier field where an Identity API exists", () => {
    state.identityApi = "https://id.example.com";
    renderDoor();
    expect(document.activeElement).toBe(
      screen.getByLabelText("Email or organization"),
    );
  });

  it("opens each road, and the local-only seal", () => {
    const props = renderDoor();
    fireEvent.click(screen.getByRole("button", { name: "Join a session" }));
    expect(props.onOpenJoin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Set up your own" }));
    expect(props.onOpenSetup).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Use without an account" }),
    );
    expect(props.onUseLocalOnly).toHaveBeenCalledTimes(1);
  });

  it("keeps guest one press away, never behind a road (AGENTS.md §5)", async () => {
    renderDoor();
    const guest = screen.getByRole("button", { name: "Continue as guest" });
    const skip = screen.getByRole("button", {
      name: "Skip sign-in and continue as guest",
    });
    fireEvent.click(guest);
    expect(continueAsGuest).toHaveBeenCalledTimes(1);
    // The card is busy until the guest road settles; the corner skip starts
    // the same road once it is free again.
    await waitFor(() => expect(skip.hasAttribute("disabled")).toBe(false));
    fireEvent.click(skip);
    expect(continueAsGuest).toHaveBeenCalledTimes(2);
  });

  it("names no deployment and no failure: a door that asks nothing reports nothing", () => {
    renderDoor();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No way in/)).toBeNull();
    expect(screen.queryByText(/Deployment setup/)).toBeNull();
  });
});
