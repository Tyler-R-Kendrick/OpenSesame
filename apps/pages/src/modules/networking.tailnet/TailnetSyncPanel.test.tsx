/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TailnetSyncState } from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { captureLinkedPairing } from "../../lib/pairing-link.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { TailnetSyncPanel, tailnetPanelSeams } from "./TailnetSyncPanel.js";

const OFF: TailnetSyncState = {
  phase: "off",
  drive: null,
  lastSyncedAt: null,
  error: null,
};

/** A stand-in observer: the panel's state, and a record of what it asked. */
const observer = (() => {
  const listeners = new Set<() => void>();
  let state = OFF;
  return {
    set(next: Partial<TailnetSyncState>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    reset() {
      state = OFF;
    },
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pairTailnetDrive: vi.fn<(code: string) => Promise<"paired" | "adopted">>(),
    syncTailnetNow: vi.fn<() => Promise<void>>(),
    forgetTailnetDrive: vi.fn<() => Promise<void>>(),
  };
})();

const originalPanelSeams = { ...tailnetPanelSeams };
const originalHooks = { ...vaultHooksSeams };
const session = { status: "unlocked" as const, guest: false };

beforeEach(() => {
  observer.reset();
  observer.pairTailnetDrive.mockReset().mockResolvedValue("paired");
  observer.syncTailnetNow.mockReset().mockResolvedValue(undefined);
  observer.forgetTailnetDrive.mockReset().mockResolvedValue(undefined);
  session.guest = false;
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), ...session }),
  });
  Object.assign(tailnetPanelSeams, {
    state: observer.state,
    subscribe: observer.subscribe,
    pair: observer.pairTailnetDrive,
    sync: observer.syncTailnetNow,
    forget: observer.forgetTailnetDrive,
  });
  window.history.replaceState(null, "", "/settings/vaults");
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(tailnetPanelSeams, originalPanelSeams);
});

describe("TailnetSyncPanel", () => {
  it("pairs from a pasted code with an icon key, not a word", async () => {
    render(<TailnetSyncPanel />);
    const field = screen.getByLabelText("Pairing code");
    fireEvent.change(field, { target: { value: " opensesame-drive:v1:abc " } });
    const pair = screen.getByRole("button", { name: "Pair with this drive" });
    expect(pair.textContent).toBe("");
    fireEvent.click(pair);
    await waitFor(() =>
      expect(observer.pairTailnetDrive).toHaveBeenCalledWith(
        " opensesame-drive:v1:abc ",
      ),
    );
  });

  it("fills in the code boot took from a pairing link", () => {
    window.history.replaceState(
      null,
      "",
      "/settings/vaults#pair-drive=opensesame-drive:v1:xyz",
    );
    captureLinkedPairing();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/settings/vaults");
    render(<TailnetSyncPanel />);
    expect(screen.getByLabelText<HTMLInputElement>("Pairing code").value).toBe(
      "opensesame-drive:v1:xyz",
    );
  });

  it("offers a guest to set the device up from the drive", () => {
    session.guest = true;
    render(<TailnetSyncPanel />);
    expect(
      screen.getByRole("button", { name: "Set this device up from the drive" }),
    ).toBeTruthy();
  });

  it("says why a pairing failed, where it was asked", async () => {
    observer.pairTailnetDrive.mockRejectedValue(
      new Error("That snapshot belongs to another vault"),
    );
    render(<TailnetSyncPanel />);
    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: "x" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Pair with this drive" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "another vault",
    );
  });

  it("shows a paired drive with its state as a glyph and two keys", async () => {
    render(<TailnetSyncPanel />);
    act(() =>
      observer.set({
        phase: "idle",
        drive: { label: "Desk", url: "https://desk.tail1.ts.net" },
        lastSyncedAt: "2026-09-24T10:00:00.000Z",
      }),
    );
    expect(screen.getByText("Desk")).toBeTruthy();
    expect(screen.getByText("desk.tail1.ts.net")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /^In step at /,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(observer.syncTailnetNow).toHaveBeenCalledOnce());
    const stop = screen.getByRole("button", {
      name: "Stop syncing this vault",
    });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(observer.forgetTailnetDrive).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByLabelText("Pairing code")).toBeNull();
  });

  it("marks a failed sync with the reason as its label", () => {
    observer.set({
      phase: "error",
      drive: { label: "", url: "https://desk.tail1.ts.net" },
      error: "The drive no longer knows this device's key. Pair again.",
    });
    render(<TailnetSyncPanel />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "Pair again",
    );
    expect(screen.getAllByText("desk.tail1.ts.net")).toHaveLength(2);
  });
});
