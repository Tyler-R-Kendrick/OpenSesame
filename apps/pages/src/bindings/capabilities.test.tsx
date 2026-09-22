/** @vitest-environment jsdom */
import { OpenFeature } from "@openfeature/web-sdk";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedPlan,
  readySnapshot,
  storeDouble,
} from "../lib/capabilities/__tests__/plan-fixtures.js";
import { installCompositionProvider } from "../lib/capabilities/openfeature.js";
import { useCapabilityFlag } from "./capabilities.js";

const CONNECTORS = "connectors.external";

describe("useCapabilityFlag (S17)", () => {
  afterEach(async () => {
    await OpenFeature.clearProviders();
  });

  it("follows the store through the provider's events", async () => {
    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    await installCompositionProvider({ snapshotSource: store });
    const { result, unmount } = renderHook(() => useCapabilityFlag(CONNECTORS));
    expect(result.current).toBe(false);
    act(() => {
      store.set(readySnapshot(approvedPlan([CONNECTORS]), 2));
    });
    expect(result.current).toBe(true);
    act(() => {
      store.set(readySnapshot(approvedPlan([]), 3));
    });
    expect(result.current).toBe(false);
    unmount();
  });
});
