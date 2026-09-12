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
import {
  ANSWERED,
  completeSetup,
  goLocalOnly,
  identityBaseHolder,
  inviteHolder,
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
    // (ADR 0115) makes the two roads large and keeps every sign-in road whole.
    fresh();
    render(<UnlockScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join a session" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set up your own" }),
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
      screen.queryByRole("button", { name: "Set up your own" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Deployment setup" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join a session" })).toBeTruthy();
  });

  it("reaches deployment setup from the front door and hands back to sign-in", () => {
    fresh();
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Set up your own" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Where do backups live?",
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Set up your own" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
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

  it("reaches the join road from the front door", () => {
    fresh();
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Join a session" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Join a session",
    );
  });

  it("opens join directly when the visit is an invite link", () => {
    // The link is the request: nobody who was invited should have to find
    // the road themselves.
    fresh();
    inviteHolder.current = {
      host: "https://host.example",
      token: "osc_clm_id.secret",
    };
    setupScreenDependencies.readJoinFromLocation = () => inviteHolder.current;
    try {
      render(<UnlockScreen />);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Join a session",
      );
    } finally {
      setupScreenDependencies.readJoinFromLocation = () => null;
    }
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

  it("names the deployment it is pointed at, and the road back into setup", () => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(screen.getByText("127.0.0.1:18788")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deployment setup" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Where do backups live?",
    );
  });

  it("offers the setup road when setup left no way in at all", () => {
    fresh();
    setupHolder.current = { ...ANSWERED, ways: [] };
    identityBaseHolder.current = "";
    waysInHolder.current = { builtin: false, providers: [] };
    render(<UnlockScreen />);
    expect(screen.getByText(/No way in is configured/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "How do people sign in?",
    );
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
