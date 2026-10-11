/** @vitest-environment jsdom */
import {
  discardPendingImport,
  holdPendingImport,
  peekPendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  ANSWERED,
  resetUnlockHarness,
  setupHolder,
  v,
} from "./unlock-screen-harness.js";

// A vault that begins from a file (ADR 0188): a backup or a .env chosen where
// a device has no vault yet is held, unread, while the vault is sealed.

beforeEach(() => {
  resetUnlockHarness();
  v.state = {
    status: "empty",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
});

afterEach(() => {
  cleanup();
  discardPendingImport();
});

const env = () => new File(["API_KEY=sk-123\n"], "app.env");

function choose(file: File): void {
  fireEvent.change(screen.getByLabelText("Choose a file to import"), {
    target: { files: [file] },
  });
}

describe("starting a vault from a file at the front door", () => {
  it("offers it as a road beside setting up and joining, with the guest Skip still in the corner", () => {
    render(<UnlockScreen />);
    expect(screen.getByRole("button", { name: "Import a file" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Set up your own/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join a session" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    ).toBeTruthy();
  });

  it("offers the file picker the Import key offers, and nothing is read", () => {
    render(<UnlockScreen />);
    const input = screen.getByLabelText<HTMLInputElement>(
      "Choose a file to import",
    );
    expect(input.accept).toContain(".env");
    expect(input.accept).toContain(".json");
    expect(peekPendingImport()).toBeNull();
  });

  it("holds the chosen file and goes straight to sealing the vault it is for", () => {
    render(<UnlockScreen />);
    const file = env();
    choose(file);

    expect(peekPendingImport()).toBe(file);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Seal this device",
    );
    expect(screen.getByText("app.env")).toBeTruthy();
    // Sealing is a local act: nothing here asks who the person is.
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sign in instead" }),
    ).toBeNull();
    expect(screen.getByRole("tab", { name: "PIN" })).toBeTruthy();
  });

  it("gives the door back when the file is removed", () => {
    render(<UnlockScreen />);
    choose(env());
    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));

    expect(peekPendingImport()).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "open-sesame" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import a file" })).toBeTruthy();
  });
});

describe("starting a vault from a file once the door has retired", () => {
  it("is a link beside Use without an account, and seals locally just the same", () => {
    setupHolder.current = ANSWERED;
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Sign in",
    );
    expect(
      screen.getByRole("button", { name: "Use without an account" }),
    ).toBeTruthy();

    choose(env());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Seal this device",
    );
    expect(screen.getByText("app.env")).toBeTruthy();
  });

  it("returns to sign-in when the file is removed", () => {
    setupHolder.current = ANSWERED;
    render(<UnlockScreen />);
    choose(env());
    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Sign in",
    );
  });

  it("is not offered beside a sealed vault, where there is already one to import into", () => {
    setupHolder.current = ANSWERED;
    v.state = {
      status: "locked",
      header: { unlocks: {} },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(screen.queryByRole("button", { name: "Import a file" })).toBeNull();
  });

  it("lets a held file go when the vault it was for is found sealed and locked", () => {
    setupHolder.current = ANSWERED;
    holdPendingImport(env());
    v.state = {
      status: "locked",
      header: { unlocks: {} },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(peekPendingImport()).toBeNull();
  });

  it("keeps the file while the unlock ceremony still has this screen up after the seal", () => {
    setupHolder.current = ANSWERED;
    const file = env();
    holdPendingImport(file);
    v.state = {
      status: "unlocked",
      header: { unlocks: {} },
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    render(<UnlockScreen />);
    expect(peekPendingImport()).toBe(file);
  });
});
