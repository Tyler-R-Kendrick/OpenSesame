/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootPersonalLocal,
  draftFor,
  freshRealm,
} from "./__tests__/harness.js";
import {
  applyPersonalLocalPwaDefaults,
  needsPersonalLocalPwaDefaults,
} from "./store-pwa-defaults.js";
import type { CompositionSnapshot } from "./store-types.js";
import { compositionStore } from "./store.js";

beforeEach(() => {
  freshRealm();
});

afterEach(() => {
  // no env stubs
});

describe("personal-local PWA defaults on boot", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
    await bootPersonalLocal();
    await applyPersonalLocalPwaDefaults(compositionStore);
    const selection = compositionStore.getSnapshot().selection;
    expect(selection?.selectedOptional).toEqual([
      "access.authority",
      "identity.local-iam",
    ]);
    expect(selection?.delivery).toEqual({
      prefetch: "selected",
      offlineCache: "selected-only",
    });
  });

  it("does not change the selection on a second boot", async () => {
    await bootPersonalLocal();
    await applyPersonalLocalPwaDefaults(compositionStore);
    const before = compositionStore.getSnapshot().selection;
    await bootPersonalLocal();
    await applyPersonalLocalPwaDefaults(compositionStore);
    expect(compositionStore.getSnapshot().selection).toStrictEqual(before);
  });
});

describe("needsPersonalLocalPwaDefaults", () => {
  it("is true with no persisted selection", async () => {
    await bootPersonalLocal();
    expect(needsPersonalLocalPwaDefaults(compositionStore.getSnapshot())).toBe(
      true,
    );
  });

  it("is true for a legacy empty selection with no consent receipt", async () => {
    await bootPersonalLocal();
    const snap = compositionStore.getSnapshot();
    const plan = snap.plan;
    if (!plan) throw new Error("store not resolved");
    const legacy: CompositionSnapshot = {
      ...snap,
      selection: {
        schemaVersion: 1,
        kind: "InstallationCapabilitySelection",
        instanceId: plan.identity.instanceId,
        installationId: plan.identity.installationId,
        basePolicyRevision: plan.identity.policyRevision,
        revision: "legacy",
        acceptedRequired: [],
        selectedOptional: [],
        chosenAlternatives: {},
        delivery: { prefetch: "none", offlineCache: "shell-only" },
      },
      receipt: null,
    };
    expect(needsPersonalLocalPwaDefaults(legacy)).toBe(true);
  });

  it("is false once a receipt exists", async () => {
    await bootPersonalLocal();
    const { draft, receipt } = draftFor(compositionStore, [], "legacy");
    await compositionStore.commit(draft, receipt);
    expect(needsPersonalLocalPwaDefaults(compositionStore.getSnapshot())).toBe(
      false,
    );
  });
});
