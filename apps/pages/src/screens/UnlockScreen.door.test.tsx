import type { CapturedInvite } from "@opensesame/app-core/lib/join/invite.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupScreenDependencies } from "./SetupScreen.js";
import { UnlockScreen } from "./UnlockScreen.js";
import { joinRoadDependencies } from "./join/JoinRoad.js";
import {
  ANSWERED,
  completeSetup,
  goLocalOnly,
  identityBaseHolder,
  resetUnlockHarness,
  setupHolder,
  submitButton,
  userMenuTrigger,
  v,
  waysInHolder,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);

// The front door and the two optional ceremonies it opens (ADR 0090, ADR
// 0115): what a device nobody has set up shows first, how setup and join are
// reached and handed back from, and what an answered record retires.

describe("UnlockScreen — setup is optional (ADR 0090)", () => {
  afterEach(cleanup);

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

  it("opens on the front door on a fresh device, with the broker and guest on offer", () => {
    // The screen this replaces was an operator's question ("This device is
    // empty") with no sign-in and no guest road on it at all. The front door
    // makes the setup road large and keeps every sign-in road whole.
    fresh();
    render(<UnlockScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Join a session/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Set up your own/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue as guest" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeTruthy();
    expect(screen.queryByText("This device is empty")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Unlock" })).toBeNull();
    // This deployment has an Identity API, so the identifier field keeps the
    // caret it took; without one the door lands on its first road
    // (FrontDoor.test.tsx covers both).
    expect(document.activeElement).toBe(
      screen.getByLabelText("Email or organization"),
    );
  });

  it("opens on the plain sign-in form once the ceremony has been answered", () => {
    fresh();
    setupHolder.current = ANSWERED;
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Sign in",
    );
    expect(
      screen.queryByRole("button", { name: /^Set up your own/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Deployment setup" }),
    ).toBeNull();
  });

  it("reaches deployment setup from the front door and hands back to sign-in", () => {
    fresh();
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^Set up your own/ }));
    // The ceremony opens on its one fixed tab — what this installation is
    // allowed to load is asked before anything optional is configured (ADR
    // 0130) — with each capability's own tab behind it.
    expect(
      screen.getByRole("tab", { selected: true }).textContent?.trim(),
    ).toBe("capabilities");
    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent?.trim()),
    ).toContain("connectors");
    // One tap after that: the brokered road needs nothing typed.
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    return waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Sign in",
      ),
    );
  });

  it("backs out of setup without recording anything", () => {
    fresh();
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^Set up your own/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it("walks from the front door to the local-only seal and back", () => {
    fresh();
    render(<UnlockScreen />);
    goLocalOnly();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Seal this device",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
  });

  it("withholds the user menu while nothing is sealed on this device", () => {
    fresh();
    render(<UnlockScreen />);
    expect(screen.queryByRole("button", { name: /Signed in as / })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Unlock" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Sign in" })).toBeNull();
  });

  it("names who locked the vault in a dropdown, with no Sign in tab", () => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(userMenuTrigger()).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Unlock" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Sign in" })).toBeNull();
    expect(submitButton()).toBeTruthy();
  });

  it("withholds deployment setup until the vault is unlocked", () => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(
      screen.queryByRole("button", { name: "Deployment setup" }),
    ).toBeNull();
    expect(screen.queryByText("127.0.0.1:18788")).toBeNull();
  });

  it("offers the setup road when setup left no way in at all", () => {
    fresh();
    setupHolder.current = { ...ANSWERED, ways: [] };
    identityBaseHolder.current = "";
    waysInHolder.current = { builtin: false, providers: [] };
    render(<UnlockScreen />);
    expect(screen.getByText(/No way in is configured/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
    expect(
      screen.getByRole("tab", { selected: true }).textContent?.trim(),
    ).toBe("identity");
  });

  it("says nothing about identity on a deployment that has one", () => {
    fresh();
    render(<UnlockScreen />);
    expect(screen.queryByText(/No way in is configured/)).toBeNull();
  });

  it("says nothing where the ways in need no identity service", () => {
    // The old line was "no identity service", and it read as broken on a
    // deployment whose Google button worked fine (ADR 0078). A provider the
    // operator brought runs in this browser and needs no service at all.
    fresh();
    identityBaseHolder.current = "";
    waysInHolder.current = {
      builtin: false,
      providers: [
        {
          providerId: "google",
          issuer: "https://accounts.google.com",
          clientId: "google-client.apps",
          label: "Google",
        },
      ],
    };
    render(<UnlockScreen />);
    expect(screen.queryByText(/No way in is configured/)).toBeNull();
  });
});

describe("UnlockScreen — joining a session (ADR 0136)", () => {
  const original = { ...joinRoadDependencies };
  afterEach(() => {
    cleanup();
    Object.assign(joinRoadDependencies, original);
  });

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

  it("offers the join road beside setup where a join can be finished", () => {
    fresh();
    joinRoadDependencies.joinAvailable = () => true;
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Join a session" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Join a session" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it("opens the join ceremony by itself when an invite link arrived", () => {
    // Locked, with a vault: an invite still opens join, because the link is
    // the request (ADR 0090 §2) — not a front-door road only.
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    const captured: CapturedInvite = {
      kind: "invite",
      invite: { token: `osc_dlg_x.${"a".repeat(43)}`, endpoint: null },
    };
    let held: CapturedInvite | null = captured;
    joinRoadDependencies.takeCapturedInvite = () => {
      const taken = held;
      held = null;
      return taken;
    };
    render(<UnlockScreen />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Join a session" }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Invite").value).toBe(
      captured.invite.token,
    );
  });
});
