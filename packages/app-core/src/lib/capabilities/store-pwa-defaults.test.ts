/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm, NOW } from "./__tests__/harness.js";
import { commitPersonalLocalPwaDefaultsIfNeeded } from "./store-pwa-defaults.js";
import { compositionStore } from "./store.js";

beforeEach(freshRealm);

describe("commitPersonalLocalPwaDefaultsIfNeeded", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
    await bootPersonalLocal();
    expect(compositionStore.getSnapshot().selection).toBeNull();
    await commitPersonalLocalPwaDefaultsIfNeeded(compositionStore, () => NOW);
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

  it("does nothing when a selection already exists", async () => {
    await bootPersonalLocal();
    await commitPersonalLocalPwaDefaultsIfNeeded(compositionStore, () => NOW);
    const before = compositionStore.getSnapshot().selection;
    await commitPersonalLocalPwaDefaultsIfNeeded(compositionStore, () => NOW);
    expect(compositionStore.getSnapshot().selection).toBe(before);
  });
});
