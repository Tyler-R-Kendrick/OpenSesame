/** @vitest-environment jsdom */
/**
 * After "Reset this browser", the tab that reset is never used again. While
 * the reset runs nothing on the lock screen can be reached (`ResetGate`),
 * and the fresh document it leaves for reads what was left behind from its
 * address and shows it first on the lock screen (`ResetLeftNotice`).
 */
import {
  captureLandingReset,
  resetLandingForTest,
} from "@opensesame/app-core/lib/browser-reset-landing.js";
import {
  beginBrowserReset,
  haltStorageWrites,
  resumeStorageWritesForTest,
} from "@opensesame/app-core/lib/storage-halt.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnlockScreen } from "./UnlockScreen.js";
import { resetUnlockHarness, v } from "./unlock-screen-harness.js";
import { ResetGate } from "./unlock/ResetGate.js";
import { resetBrowserSeams } from "./unlock/reset-browser-run.js";

const original = { ...resetBrowserSeams };

beforeEach(resetUnlockHarness);
afterEach(() => {
  cleanup();
  Object.assign(resetBrowserSeams, original);
  resumeStorageWritesForTest();
  resetLandingForTest();
  window.history.replaceState(null, "", "/");
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

function sealed() {
  v.state = {
    status: "locked",
    tomb: "personal",
    header: { unlocks: { password: {} } },
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
  v.methods = ["password"];
  v.preferred = "password";
}

function arriveAt(address: string): void {
  window.history.replaceState(null, "", address);
  captureLandingReset();
}

describe("the tab that resets", () => {
  it("offers nothing on the lock screen from the moment the reset begins", async () => {
    sealed();
    resetBrowserSeams.reset = () => {
      beginBrowserReset();
      return new Promise(() => undefined);
    };
    render(
      <ResetGate>
        <UnlockScreen />
      </ResetGate>,
    );
    expect(screen.getByRole("button", { name: "Skip to the guest vault" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset this browser?" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Erase this browser" }));

    const status = await screen.findByRole("status", {
      name: "Resetting this browser",
    });
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(document.querySelector("input, button, a[href]")).toBeNull();
    expect(document.activeElement).toBe(status);
  });

  it("offers nothing in a tab that heard another tab's reset", () => {
    fresh();
    render(
      <ResetGate>
        <UnlockScreen />
      </ResetGate>,
    );
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);

    act(() => haltStorageWrites());

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("status", { name: "Resetting this browser" }));
  });
});

describe("the fresh document a reset left for", () => {
  it("shows what was left first on the front door, and takes it off the address", () => {
    fresh();
    arriveAt(
      "/?reset-failed=databases&reset-kept=caches,service_workers,nonsense",
    );
    render(<UnlockScreen />);

    const left = screen.getByRole("list", { name: "Still in this browser" });
    const marks = [...left.querySelectorAll("[role=img]")].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(marks).toEqual([
      "History backups: not erased",
      "Offline app: kept while offline",
      "Offline worker: kept while offline",
    ]);
    expect(window.location.search).toBe("");
    // First on the card: ahead of every road in.
    const setUp = screen.getByRole("button", { name: /^Set up your own/ });
    expect(
      left.compareDocumentPosition(setUp) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Skip sign-in and continue as guest",
      }),
    );
  });

  it("shows it beside a vault a failed reset could not remove", () => {
    sealed();
    arriveAt("/?reset-failed=origin_files");
    render(<UnlockScreen />);
    expect(
      screen.getByRole("img", { name: "Vaults and settings: not erased" }),
    ).toBeTruthy();
  });

  it("dismisses, or erases again and leaves again", async () => {
    fresh();
    arriveAt("/?reset-kept=caches");
    const leave = vi.fn();
    const reset = vi.fn(async () => ({
      cleared: [],
      failed: [],
      kept: [],
    }));
    Object.assign(resetBrowserSeams, { reset, leave });
    const { unmount } = render(<UnlockScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Erase again" }));
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    unmount();

    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByRole("list", { name: "Still in this browser" }),
    ).toBeNull();
  });

  it("says nothing on an ordinary arrival", () => {
    fresh();
    arriveAt("/?reset-kept=everything");
    render(<UnlockScreen />);
    expect(
      screen.queryByRole("list", { name: "Still in this browser" }),
    ).toBeNull();
  });
});
