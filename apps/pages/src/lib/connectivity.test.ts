/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOnline, subscribeConnectivity } from "./connectivity.js";

describe("connectivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the navigator online state", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(isOnline()).toBe(true);
    vi.stubGlobal("navigator", { onLine: false });
    expect(isOnline()).toBe(false);
  });

  it("treats a missing navigator as online", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(isOnline()).toBe(true);
  });

  it("notifies subscribers on online/offline and stops after unsubscribe", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConnectivity((online) => seen.push(online));

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);

    unsubscribe();
    window.dispatchEvent(new Event("offline"));
    expect(seen).toEqual([false, true]);
  });
});
