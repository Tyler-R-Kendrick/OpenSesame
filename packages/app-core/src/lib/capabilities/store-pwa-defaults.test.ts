/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
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
  const plan = {
    identity: {
      instanceId: "personal-local",
      installationId: "inst",
      policyRevision: "0",
    },
  } as CompositionSnapshot["plan"];

  function snap(
    overrides: Partial<CompositionSnapshot>,
  ): CompositionSnapshot {
    return {
      plan,
      provenance: "personal-local",
      selection: null,
      receipt: null,
      ...overrides,
    } as CompositionSnapshot;
  }

  it("is true with no persisted selection", () => {
    expect(needsPersonalLocalPwaDefaults(snap({}))).toBe(true);
  });

  it("is true for a legacy empty selection with no consent receipt", () => {
    expect(
      needsPersonalLocalPwaDefaults(
        snap({
          selection: {
            schemaVersion: 1,
            kind: "InstallationCapabilitySelection",
            instanceId: "personal-local",
            installationId: "inst",
            basePolicyRevision: "0",
            revision: "legacy",
            acceptedRequired: [],
            selectedOptional: [],
            chosenAlternatives: {},
            delivery: { prefetch: "none", offlineCache: "none" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("is false once a receipt exists", () => {
    expect(
      needsPersonalLocalPwaDefaults(
        snap({
          selection: {
            schemaVersion: 1,
            kind: "InstallationCapabilitySelection",
            instanceId: "personal-local",
            installationId: "inst",
            basePolicyRevision: "0",
            revision: "legacy",
            acceptedRequired: [],
            selectedOptional: [],
            chosenAlternatives: {},
            delivery: { prefetch: "none", offlineCache: "none" },
          },
          receipt: {
            schemaVersion: 1,
            kind: "ConsentReceipt",
            instanceId: "personal-local",
            installationId: "inst",
            acceptedAt: "2020-01-01T00:00:00.000Z",
            exposureDigest: "00",
            selectionRevision: "legacy",
          },
        }),
      ),
    ).toBe(false);
  });
});
