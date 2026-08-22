/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const endSession = vi.hoisted(() => vi.fn());
const clearStagedClaimTokens = vi.hoisted(() => vi.fn());
const hostFetch = vi.hoisted(() => vi.fn());

import { identitySeams } from "../identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  endSession,
  clearStagedClaimTokens,
  hostFetch,
  ensureHostSession: vi.fn().mockResolvedValue(undefined),
  hostLocalSessionEligible: () => false,
});
import { queueSeams } from "../queue.js";
const originalQueueSeams = { ...queueSeams };
Object.assign(queueSeams, { clearStagedClaimTokens });

import {
  clearCopiedSecret,
  useCopySecret,
  useSessionGuards,
  useTheme,
  useVault,
  useVaultStore,
} from "./hooks.js";
import { vaultStore } from "./store.js";

type ClipboardStub = {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
};

function stubClipboard(overrides: Partial<ClipboardStub> = {}): ClipboardStub {
  const clipboard: ClipboardStub = {
    readText: vi.fn().mockResolvedValue(""),
    writeText: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return clipboard;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useRealTimers();
  endSession.mockReset();
  clearStagedClaimTokens.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useVault / useVaultStore", () => {
  it("exposes the store snapshot and re-renders on change", () => {
    const seen: string[] = [];
    function Probe() {
      const state = useVault();
      seen.push(state.status);
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toBe(vaultStore.getSnapshot().status);

    act(() => {
      vaultStore.setPrefs({ theme: "dark" });
    });
    expect(vaultStore.getSnapshot().prefs.theme).toBe("dark");
    act(() => {
      vaultStore.setPrefs({ theme: "system" });
    });
  });

  it("hands back the singleton store", () => {
    const { result } = renderHook(() => useVaultStore());
    expect(result.current).toBe(vaultStore);
  });
});

describe("useSessionGuards", () => {
  it("wipes the clipboard and staged claims on lock", () => {
    renderHook(() => useSessionGuards());
    act(() => {
      vaultStore.lock();
    });
    expect(clearStagedClaimTokens).toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });

  it("also ends the identity session when the operator opted in", () => {
    act(() => {
      vaultStore.setPrefs({ signOutOnLock: true });
    });
    renderHook(() => useSessionGuards());
    act(() => {
      vaultStore.lock();
    });
    expect(endSession).toHaveBeenCalled();
    act(() => {
      vaultStore.setPrefs({ signOutOnLock: false });
    });
  });

  it("stops listening once unmounted", () => {
    const { unmount } = renderHook(() => useSessionGuards());
    unmount();
    clearStagedClaimTokens.mockClear();
    act(() => {
      vaultStore.lock();
    });
    expect(clearStagedClaimTokens).not.toHaveBeenCalled();
  });

  it("counts activity events while unlocked", () => {
    const snapshot = vaultStore.getSnapshot();
    const touch = vi.spyOn(vaultStore, "touch").mockImplementation(() => {});
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      status: "unlocked",
    });

    renderHook(() => useSessionGuards());
    act(() => {
      window.dispatchEvent(new Event("keydown"));
    });
    expect(touch).toHaveBeenCalled();

    // The visibility listener also counts coming back to the tab.
    setVisibility("visible");
    touch.mockClear();
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(touch).toHaveBeenCalled();
  });

  it("throttles pointermove so a sweeping mouse is not a busy loop", () => {
    vi.useFakeTimers();
    const snapshot = vaultStore.getSnapshot();
    const touch = vi.spyOn(vaultStore, "touch").mockImplementation(() => {});
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      status: "unlocked",
    });

    renderHook(() => useSessionGuards());
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(touch).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(15_000);
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it("locks on tab hide only when the operator asked for it", () => {
    const snapshot = vaultStore.getSnapshot();
    const lock = vi.spyOn(vaultStore, "lock").mockImplementation(() => {});
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      status: "unlocked",
      prefs: { ...snapshot.prefs, lockOnHide: true },
    });

    renderHook(() => useSessionGuards());
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lock).toHaveBeenCalled();
    setVisibility("visible");
  });
});

describe("useCopySecret", () => {
  it("copies and schedules a clipboard clear", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 30 });
    });

    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("hunter2")).resolves.toBe("copied");
    expect(clipboard.writeText).toHaveBeenCalledWith("hunter2");

    // The scheduled clear only blanks the clipboard when it still holds ours.
    clipboard.readText.mockResolvedValue("hunter2");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("leaves a clipboard someone else has since overwritten alone", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 10 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("ours");
    clipboard.readText.mockResolvedValue("theirs");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("does not arm a timer when clearing is disabled", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("kept")).resolves.toBe("copied");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 30 });
    });
  });

  it("reports unavailable when the write is rejected or the API is missing", async () => {
    const clipboard = stubClipboard({
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    const { result } = renderHook(() => useCopySecret());
    await expect(result.current("x")).resolves.toBe("unavailable");
    void clipboard;

    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const { result: missing } = renderHook(() => useCopySecret());
    await expect(missing.current("x")).resolves.toBe("unavailable");
  });

  it("a second copy replaces the pending clear of the first", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 10 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("first");
    await result.current("second");
    clipboard.readText.mockResolvedValue("second");
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    // Exactly one pending clear survived: the one for the latest copy.
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });
});

describe("clearCopiedSecret", () => {
  it("is a no-op when nothing was copied", () => {
    const clipboard = stubClipboard();
    clearCopiedSecret();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("clears the tracked secret immediately, cancelling any pending timer", async () => {
    vi.useFakeTimers();
    const clipboard = stubClipboard();
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 60 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.readText.mockResolvedValue("secret-value");
    clipboard.writeText.mockClear();

    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");

    // The cancelled timer must not fire later.
    clipboard.writeText.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("falls back to an unconditional clear when reads are denied", async () => {
    const clipboard = stubClipboard({
      readText: vi.fn().mockRejectedValue(new Error("denied")),
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clipboard.writeText.mockClear();

    clearCopiedSecret();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenLastCalledWith("");
  });

  it("swallows a clipboard that rejects every touch", async () => {
    stubClipboard({
      readText: vi.fn().mockRejectedValue(new Error("denied")),
      writeText: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("denied")),
    });
    act(() => {
      vaultStore.setPrefs({ clipboardClearSeconds: 0 });
    });

    const { result } = renderHook(() => useCopySecret());
    await result.current("secret-value");
    clearCopiedSecret();
    // Must not produce an unhandled rejection.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

describe("useTheme", () => {
  it("applies the theme attribute and removes it for system", () => {
    const initialProps: { theme: "system" | "light" | "dark" } = {
      theme: "dark",
    };
    const { rerender } = renderHook(
      ({ theme }: { theme: "system" | "light" | "dark" }) => {
        const snapshot = vaultStore.getSnapshot();
        vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
          ...snapshot,
          prefs: { ...snapshot.prefs, theme },
        });
        useTheme();
      },
      { initialProps },
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    rerender({ theme: "light" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    rerender({ theme: "system" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
