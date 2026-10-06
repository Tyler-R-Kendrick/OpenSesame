import { manualPassword } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareReachSeams } from "../local-share-reach.js";
import { updateLocalAccountPasswordMethod } from "./account-password-write.js";
import { stampedEdit } from "./body-edits.js";
import { writeItem } from "./item-path.js";
import {
  openWorkflowVault,
  readBody,
  sealedBody,
  testAccount,
} from "./password-workflows.test-support.js";
import { vaultStore } from "./store.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const original = testAccount("Account", "ORIGINAL_PRIVATE");
  original.methods.push({
    id: "api",
    type: "api-key",
    key: "API_PRIVATE",
    header: "X-API-Key",
  });
  const state = openWorkflowVault([original]);
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
  const password = original.methods[0];
  if (password?.type !== "password")
    throw new Error("Missing fixture password");
  const next = manualPassword(
    password.id,
    "NEXT_PRIVATE",
    new Date().toISOString(),
  );
  return { original, state, next };
}

describe("account authoritative password write", () => {
  it("does not resurrect an account withdrawn before a private prompt completes", async () => {
    const { original, state, next } = fixture();
    state.items = [];
    await expect(
      updateLocalAccountPasswordMethod("personal", original, next),
    ).rejects.toThrow("withdrawn");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });
  it("rejects account withdrawal during the write permission check", async () => {
    const { original, state, next } = fixture();
    vi.mocked(shareReachSeams.resolveCurrentAccessRole).mockImplementationOnce(
      async () => {
        state.items = [];
        return "operator";
      },
    );
    await expect(
      updateLocalAccountPasswordMethod("personal", original, next),
    ).rejects.toThrow("withdrawn");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });
  it("rejects concurrent unrelated method changes rather than overwriting them", async () => {
    const { original, state, next } = fixture();
    state.items = [{ ...original, notes: "Concurrent update" }];
    await expect(
      updateLocalAccountPasswordMethod("personal", original, next),
    ).rejects.toThrow("changed");
    expect(vaultStore.saveItem).not.toHaveBeenCalled();
  });
  it("saves once and preserves every unrelated account field and method", async () => {
    const { original, state, next } = fixture();
    await updateLocalAccountPasswordMethod("personal", original, next);
    expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
    expect(state.items[0]).toEqual({
      ...original,
      updatedAt: expect.any(String),
      // The method's clock is its credential's (ADR 0179).
      fieldTimes: {},
      methods: [next, original.methods[1]],
    });
  });
  it("accepts canonical-equivalent account and persisted readback property order", async () => {
    const { original, state, next } = fixture();
    const { methods: originalMethods, ...originalProperties } = original;
    state.items = [{ methods: originalMethods, ...originalProperties }];
    vi.mocked(vaultStore.saveItem).mockImplementationOnce(async (item) => {
      if (item.kind !== "account") throw new Error("Expected account");
      const body = sealedBody(state.items);
      stampedEdit((draft) => writeItem(draft, item))(body);
      const persisted = readBody(body)[0];
      if (persisted?.kind !== "account")
        throw new Error("Expected persisted account");
      const { methods: persistedMethods, ...persistedProperties } = persisted;
      state.items = [{ methods: persistedMethods, ...persistedProperties }];
    });
    await expect(
      updateLocalAccountPasswordMethod("personal", original, next),
    ).resolves.toBeUndefined();
    expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
  });
  it("suppresses private write failures without retrying", async () => {
    const { original, next } = fixture();
    vi.mocked(vaultStore.saveItem).mockRejectedValue(new Error("NEXT_PRIVATE"));
    await expect(
      updateLocalAccountPasswordMethod("personal", original, next),
    ).rejects.toThrow("details suppressed");
    expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
  });
});
