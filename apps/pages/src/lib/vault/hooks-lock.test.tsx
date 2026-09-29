/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
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

import * as documentLifecycle from "@opensesame/app-core/lib/document-lifecycle.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useSessionGuards } from "./hooks.js";

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

describe("useSessionGuards lock on hide", () => {
  it("does not lock when a script dispatches visibilitychange", () => {
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
    expect(lock).not.toHaveBeenCalled();
    setVisibility("visible");
  });

  it("locks when the hide decision retires, and a visible return does not", () => {
    const snapshot = vaultStore.getSnapshot();
    const lock = vi.spyOn(vaultStore, "lock").mockImplementation(() => {});
    const decide = vi
      .spyOn(documentLifecycle, "trustedHideRetires")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
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
    expect(decide).toHaveBeenCalledWith({
      trusted: false,
      hidden: true,
      lockOnHide: true,
      unlocked: true,
    });
    expect(lock).toHaveBeenCalledTimes(1);

    lock.mockClear();
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lock).not.toHaveBeenCalled();
    decide.mockRestore();
  });

  it("does not lock on hide when the operator left lock-on-hide off", () => {
    const snapshot = vaultStore.getSnapshot();
    const lock = vi.spyOn(vaultStore, "lock").mockImplementation(() => {});
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      status: "unlocked",
      prefs: { ...snapshot.prefs, lockOnHide: false },
    });

    renderHook(() => useSessionGuards());
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lock).not.toHaveBeenCalled();
    setVisibility("visible");
  });
});
