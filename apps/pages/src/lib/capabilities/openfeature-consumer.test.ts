/** @vitest-environment jsdom */
import { InMemoryProvider, OpenFeature } from "@openfeature/web-sdk";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import {
  approvedPlan,
  readySnapshot,
  storeDouble,
} from "./__tests__/plan-fixtures.js";
import { loadApprovedModule } from "./loader.js";
import {
  RELEASE_FLAGS,
  capabilityEnabled,
  capabilityShown,
  isReleaseFlagName,
  releaseFlagRestricts,
  releaseFlagSeams,
  useCapabilityFlag,
} from "./openfeature-consumer.js";
import {
  OPENFEATURE_DOMAIN,
  capabilityFlagKey,
  installCompositionProvider,
} from "./openfeature.js";
import { isCapabilityDenied } from "./runtime-contract.js";
import { compositionStore } from "./store.js";

const CONNECTORS = "connectors.external";

describe("openfeature-consumer (S17)", () => {
  beforeEach(() => {
    releaseFlagSeams.table = RELEASE_FLAGS;
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    releaseFlagSeams.table = RELEASE_FLAGS;
  });

  it("OF-02/OF-04: with no provider, or a provider that is not ready, a capability reads false", async () => {
    expect(capabilityEnabled(CONNECTORS)).toBe(false);
    const store = storeDouble({
      status: "resolving",
      plan: null,
      generation: 0,
      lifecycle: {},
    });
    await installCompositionProvider({ snapshotSource: store });
    expect(capabilityEnabled(CONNECTORS)).toBe(false);
  });

  it("useCapabilityFlag follows the store through the provider's events", async () => {
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

  it("OF-05: a malicious provider can lie to the UI but never to the loader", async () => {
    freshRealm();
    await bootPersonalLocal();
    const snapshot = compositionStore.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.plan?.approvedCapabilities).not.toContain(CONNECTORS);
    await OpenFeature.setProviderAndWait(
      OPENFEATURE_DOMAIN,
      new InMemoryProvider({
        [capabilityFlagKey(CONNECTORS)]: {
          disabled: false,
          variants: { on: true },
          defaultVariant: "on",
        },
      }),
    );
    // The facade is advisory and now says yes...
    expect(capabilityEnabled(CONNECTORS)).toBe(true);
    // ...and the loader, reading the store, still refuses before any import.
    const lease = compositionStore.currentLease();
    const outcome = await loadApprovedModule(
      `${CONNECTORS}/runtime`,
      lease,
    ).then(
      () => "loaded",
      (error: unknown) => (isCapabilityDenied(error) ? error.code : "other"),
    );
    expect(outcome).toBe("NOT_APPROVED");
    compositionStore.resetForTest();
  });

  it("OF-08: a release flag can only restrict; it never enables a capability", async () => {
    releaseFlagSeams.table = {
      "release.shown-thing": "shown",
      "release.hidden-thing": "restricted",
    };
    expect(isReleaseFlagName("release.x")).toBe(true);
    expect(isReleaseFlagName("capability.x")).toBe(false);
    expect(releaseFlagRestricts("release.shown-thing")).toBe(false);
    expect(releaseFlagRestricts("release.hidden-thing")).toBe(true);
    expect(releaseFlagRestricts("release.unknown")).toBe(true);
    expect(releaseFlagRestricts("capability.connectors.external")).toBe(true);

    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    await installCompositionProvider({ snapshotSource: store });
    // Not approved: a "shown" release flag cannot turn it on.
    expect(capabilityShown(CONNECTORS, "release.shown-thing")).toBe(false);
    store.set(readySnapshot(approvedPlan([CONNECTORS]), 2));
    expect(capabilityShown(CONNECTORS)).toBe(true);
    expect(capabilityShown(CONNECTORS, "release.shown-thing")).toBe(true);
    // Approved: a restricted release flag hides it.
    expect(capabilityShown(CONNECTORS, "release.hidden-thing")).toBe(false);
  });

  it("OF-08: release flags never come from the provider", async () => {
    await OpenFeature.setProviderAndWait(
      OPENFEATURE_DOMAIN,
      new InMemoryProvider({
        "release.hidden-thing": {
          disabled: false,
          variants: { on: true },
          defaultVariant: "on",
        },
      }),
    );
    releaseFlagSeams.table = { "release.hidden-thing": "restricted" };
    expect(releaseFlagRestricts("release.hidden-thing")).toBe(true);
  });
});
