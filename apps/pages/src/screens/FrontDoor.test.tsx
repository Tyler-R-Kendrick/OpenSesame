import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/** @vitest-environment jsdom */
import { identityHookSeams } from "../bindings/identity.js";
import { expectInTray } from "../components/tray.test-support.js";

import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { federationSeams } from "@opensesame/app-core/lib/federation.js";
import { guestAuthSeams } from "@opensesame/app-core/lib/guest-auth.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import type { PagesSettings } from "@opensesame/app-core/lib/settings.js";
import {
  defaultSignInMethods,
  settingsSeams,
} from "@opensesame/app-core/lib/settings.js";
import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import { isFunction } from "@opensesame/os-domain";

/**
 * The front door (ADR 0115, ADR 0150 §1): two roads made large — set up your
 * own, join a session — and the guest road as the corner Skip. No sign-in:
 * a device with no vault has nothing to sign in to. Its contract is the
 * arrival — what is on the screen, in which order, and where the keyboard
 * lands — because the roads themselves only open ceremonies other suites
 * cover.
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
});
Object.assign(identityHookSeams, {
  useIdentitySession: () => null,
});
Object.assign(deviceIdentitySeams, {
  remoteIdentityApi: () => state.identityApi,
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
    onOpenSetup: vi.fn(),
    onOpenJoin: vi.fn(),
    ...overrides,
  };
  render(<FrontDoor {...props} />);
  return props;
}

function ensureMemoryLocalStorage(): void {
  if (globalThis.localStorage && isFunction(globalThis.localStorage.getItem)) {
    return;
  }
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        const value = store.get(key);
        return value === undefined ? null : value;
      },
      key(index: number) {
        return [...store.keys()][index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    } satisfies Storage,
  });
}

beforeEach(() => {
  ensureMemoryLocalStorage();
  state.identityApi = "";
  continueAsGuest.mockReset();
  continueAsGuest.mockResolvedValue(undefined);
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(cleanup);

describe("the front door", () => {
  it("titles the screen with the wordmark and offers two roads and nothing else", () => {
    renderDoor();
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(document.querySelector("h1.wordmark .wordmark__slots")).toBeTruthy();
    const names = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    // Document order is Tab order: the corner skip, then the two roads.
    expect(names).toEqual(
      expect.arrayContaining([
        "Skip sign-in and continue as guest",
        "Set up your own",
        "Join a session",
      ]),
    );
    expect(names.indexOf("Set up your own")).toBeLessThan(
      names.indexOf("Join a session"),
    );
    expect(
      screen
        .getByRole("button", { name: "Set up your own" })
        .getAttribute("aria-describedby"),
    ).toBe("door-setup-kind");
    // Sign-in is for a device that holds a vault (ADR 0150 §1).
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Skip to the guest vault" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use without an account" }),
    ).toBeNull();
    expect(screen.queryByText("or sign in")).toBeNull();
    expect(screen.queryByLabelText("Email or organization")).toBeNull();
  });

  it("lands the keyboard on the first road, even where an Identity API exists", () => {
    state.identityApi = "https://id.example.com";
    renderDoor();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Set up your own" }),
    );
  });

  it("opens each road", () => {
    const props = renderDoor();
    fireEvent.click(screen.getByRole("button", { name: "Set up your own" }));
    expect(props.onOpenSetup).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Join a session" }));
    expect(props.onOpenJoin).toHaveBeenCalledTimes(1);
  });

  it("keeps guest one press away in the corner, never behind a road (AGENTS.md §5)", async () => {
    renderDoor();
    const skip = screen.getByRole("button", {
      name: "Skip sign-in and continue as guest",
    });
    fireEvent.click(skip);
    expect(continueAsGuest).toHaveBeenCalledTimes(1);
    // The card is busy until the guest road settles, then it is free again.
    await waitFor(() => expect(skip.hasAttribute("disabled")).toBe(false));
    fireEvent.click(skip);
    expect(continueAsGuest).toHaveBeenCalledTimes(2);
  });

  it("says why when the guest road fails", async () => {
    continueAsGuest.mockRejectedValueOnce(new Error("Storage is full"));
    renderDoor();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Storage is full" })).toBeTruthy(),
    );
    await expectInTray("Storage is full");
  });

  it("names no deployment and no failure: a door that asks nothing reports nothing", () => {
    renderDoor();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/No way in/)).toBeNull();
    expect(screen.queryByText(/Deployment setup/)).toBeNull();
  });

  it("keeps a seat for the help key beside the theme key, in the card's corner (ADR 0166)", () => {
    renderDoor();
    const corner = document.querySelector(".door__theme");
    expect(corner).not.toBeNull();
    // The seat is empty here (no support capability in this suite) and takes
    // no room; with the capability the key is portalled into it.
    expect(corner?.querySelector(".gate-seat")).not.toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toHaveLength(1);
  });

  it("is the guest Skip a tutorial can point at, and the road stays one press away", () => {
    renderDoor();
    const skip = screen.getByRole("button", {
      name: "Skip sign-in and continue as guest",
    });
    expect(resolveGuideTargetElement("unlock.guest")).toBe(skip);
    expect(resolveGuideTargetElement("unlock.setup")).toBe(
      screen.getByRole("button", { name: "Set up your own" }),
    );
    expect(resolveGuideTargetElement("setup.join")).toBe(
      screen.getByRole("button", { name: "Join a session" }),
    );
  });
});
