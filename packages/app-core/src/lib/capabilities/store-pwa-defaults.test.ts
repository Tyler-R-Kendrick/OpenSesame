/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import { applyPersonalLocalPwaDefaults } from "./store-pwa-defaults.js";
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
