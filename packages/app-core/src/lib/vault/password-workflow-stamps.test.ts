import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shareReachSeams } from "../local-share-reach.js";
import { updateLocalAccountPasswordMethod } from "./account-password-write.js";
import { stampedEdit } from "./body-edits.js";
import { writeItem } from "./item-path.js";
import { comparePrivatePassword } from "./password-workflows.js";
import {
  openWorkflowVault,
  readBody,
  sealedBody,
  testAccount,
} from "./password-workflows.test-support.js";
import { vaultStore } from "./store.js";

beforeEach(() => {
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
function persistedFixture() {
  const account = testAccount("Stamped account", "ORIGINAL_PRIVATE");
  account.fieldTimes = { notes: "2000-01-01T00:00:00.000Z" };
  const other = createItem("note", "Other device clock");
  other.updatedAt = "2099-01-01T00:00:00.000Z";
  const body = sealedBody([account, other]);
  const state = openWorkflowVault(readBody(body));
  vi.mocked(vaultStore.saveItem).mockImplementation(async (item) => {
    stampedEdit((draft) => writeItem(draft, item))(body);
    state.items = readBody(body);
  });
  return { account, body, state };
}
it("verifies actual stamped password writes while preserving sibling values and existing field clocks", async () => {
  const { account, body } = persistedFixture();
  await expect(
    comparePrivatePassword(account.id, "NEW_PRIVATE", true),
  ).resolves.toMatchObject({ verified: true });
  const saved = body.items.find((item) => item.id === account.id);
  // The password's clock is its credential's, not the account's (ADR 0178).
  expect(saved?.fieldTimes).toEqual({ notes: account.fieldTimes?.notes });
  const held = body.items.find((item) => item.id === account.methods[0]?.id);
  expect(held?.updatedAt).toBe(saved?.updatedAt);
  expect(saved?.updatedAt).toBe("2099-01-01T00:00:00.001Z");
  expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
});
it("verifies the human account action through the same authoritative stamped write boundary", async () => {
  const { account } = persistedFixture();
  const method = account.methods[0];
  if (method?.type !== "password") throw new Error("Missing fixture password");
  await expect(
    updateLocalAccountPasswordMethod("personal", account, {
      ...method,
      secret: "NEW_PRIVATE",
    }),
  ).resolves.toBeUndefined();
  expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
});
it.each(["unexpected clock", "unchanged clock", "password content"])(
  "rejects %s tampering after the authoritative stamp without retry",
  async (tamper) => {
    const { account, body, state } = persistedFixture();
    vi.mocked(vaultStore.saveItem).mockImplementationOnce(async (item) => {
      stampedEdit((draft) => writeItem(draft, item))(body);
      const saved = body.items.find((entry) => entry.id === account.id);
      if (saved?.kind !== "account")
        throw new Error("Missing saved fixture account");
      if (tamper === "unexpected clock")
        saved.fieldTimes = { ...saved.fieldTimes, unexpected: saved.updatedAt };
      if (tamper === "unchanged clock")
        saved.fieldTimes = { ...saved.fieldTimes, notes: saved.updatedAt };
      if (tamper === "password content") {
        const held = body.items.find((entry) => entry.kind === "credential");
        if (held?.kind !== "credential" || held.method.type !== "password")
          throw new Error("Missing fixture credential");
        held.method = { ...held.method, secret: "CORRUPTED_PRIVATE" };
      }
      state.items = readBody(body);
    });
    await expect(
      comparePrivatePassword(account.id, "NEW_PRIVATE", true),
    ).rejects.toThrow("unverified");
    expect(vaultStore.saveItem).toHaveBeenCalledTimes(1);
  },
);
