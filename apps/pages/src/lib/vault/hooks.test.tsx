/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const endSession = vi.hoisted(() => vi.fn());
const clearStagedClaimTokens = vi.hoisted(() => vi.fn());
const hostFetch = vi.hoisted(() => vi.fn());
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
const originalIdentitySeams = { ...identitySeams };
Object.assign(identitySeams, {
  endSession,
  clearStagedClaimTokens,
  hostFetch,
  ensureHostSession: vi.fn().mockResolvedValue(undefined),
  hostLocalSessionEligible: () => false,
});
afterAll(() => Object.assign(identitySeams, originalIdentitySeams));
import { queueSeams } from "@opensesame/app-core/lib/queue.js";
const originalQueueSeams = { ...queueSeams };
Object.assign(queueSeams, { clearStagedClaimTokens });
afterAll(() => Object.assign(queueSeams, originalQueueSeams));

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useSessionGuards, useVault, useVaultStore } from "./hooks.js";

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
});
