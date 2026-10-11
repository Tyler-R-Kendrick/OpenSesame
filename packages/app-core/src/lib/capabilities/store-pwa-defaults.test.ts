/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import { commitPersonalLocalPwaDefaultsIfNeeded } from "./store-pwa-defaults.js";
import { compositionStore, storeSeams } from "./store.js";

async function bootPersonalLocalWithPwaDefaults(): Promise<void> {
  await bootPersonalLocal();
  await commitPersonalLocalPwaDefaultsIfNeeded(
    compositionStore,
    storeSeams.now,
  );
}

beforeEach(freshRealm);

describe("personal-local PWA defaults on boot", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
    storeSeams.skipPersonalLocalPwaDefaults = false;
    await bootPersonalLocalWithPwaDefaults();
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
    storeSeams.skipPersonalLocalPwaDefaults = false;
    await bootPersonalLocalWithPwaDefaults();
    const before = compositionStore.getSnapshot().selection;
    await bootPersonalLocalWithPwaDefaults();
    expect(compositionStore.getSnapshot().selection).toStrictEqual(before);
  });
});
