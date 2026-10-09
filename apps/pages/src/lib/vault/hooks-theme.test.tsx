/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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

import { useTheme } from "./hooks.js";

afterEach(() => {
  cleanup();
});

describe("useTheme", () => {
  it("applies the theme attribute and removes it for system", async () => {
    const { setTheme } = await import("../theme.js");
    const { rerender } = renderHook(() => {
      useTheme();
    });
    act(() => {
      setTheme("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    act(() => {
      setTheme("light");
    });
    rerender();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => {
      setTheme("system");
    });
    rerender();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
