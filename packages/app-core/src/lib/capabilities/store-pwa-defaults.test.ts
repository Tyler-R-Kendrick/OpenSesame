/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import { compositionStore } from "./store.js";

beforeEach(() => {
  freshRealm();
  vi.stubEnv("MODE", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("personal-local PWA defaults on boot", () => {
  it("commits Access and browser-local IAM when nothing is persisted", async () => {
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
    await bootPersonalLocal();
    const before = compositionStore.getSnapshot().selection;
    await bootPersonalLocal();
    expect(compositionStore.getSnapshot().selection).toStrictEqual(before);
  });
});
