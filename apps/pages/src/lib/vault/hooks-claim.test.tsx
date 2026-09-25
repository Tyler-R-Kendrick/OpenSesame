/** @vitest-environment jsdom */
/**
 * The vault lock path forgets a claim or drop link the locked session was
 * shown (ADR 0140 plan step 8) — and keeps one that arrived on a device that
 * was already locked, so the guest road can still reach it.
 */
import {
  captureClaimArrivalFromPage,
  markClaimShown,
  peekClaimArrival,
  resetClaimArrivalForTests,
} from "@opensesame/app-core/lib/claims/arrival.js";
import { claimStash } from "@opensesame/app-core/lib/claims/stash.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionGuards } from "./hooks.js";

afterEach(() => {
  cleanup();
  resetClaimArrivalForTests();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("useSessionGuards and a claim link", () => {
  it("forgets a claim the locked session was shown, and only that", () => {
    history.replaceState(null, "", "/claim#token=osc_clm_pub.secret"); // gitleaks:allow -- synthetic claim-shaped test vector
    captureClaimArrivalFromPage();
    renderHook(() => useSessionGuards());

    act(() => {
      vaultStore.lock();
    });
    expect(peekClaimArrival().kind).toBe("claim");
    expect(claimStash.read()).not.toBeNull();

    markClaimShown();
    act(() => {
      vaultStore.lock();
    });
    expect(peekClaimArrival()).toEqual({ kind: "none" });
    expect(claimStash.read()).toBeNull();
  });
});
