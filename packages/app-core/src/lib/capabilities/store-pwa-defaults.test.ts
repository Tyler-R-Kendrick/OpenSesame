/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import { compositionStore, storeSeams } from "./store.js";

beforeEach(freshRealm);

describe("personal-local PWA defaults on boot", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
    storeSeams.skipPersonalLocalPwaDefaults = false;
    await bootPersonalLocal();
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
    await bootPersonalLocal();
    const before = compositionStore.getSnapshot().selection;
    await bootPersonalLocal();
    expect(compositionStore.getSnapshot().selection).toStrictEqual(before);
  });
});
