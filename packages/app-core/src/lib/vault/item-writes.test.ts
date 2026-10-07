import { createItem, emptyBody, manualPassword } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { shareReachSeams } from "../local-share-reach.js";
import { itemText, withdrawFromBody } from "./item-departure.js";
import { writeSavedItems } from "./item-writes.js";
import { resetPasswordHistoryForTest } from "./password-history.js";
import { comparePrivatePassword } from "./password-workflows.js";
import { openWorkflowVault } from "./password-workflows.test-support.js";
import { vaultStore } from "./store.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPasswordHistoryForTest();
});
it("rejects a contextual password update when travel withdrawal wins the queued mutation", async () => {
  const original = createItem("account", "Travel account");
  original.methods = [
    manualPassword(
      "password-primary",
      "ORIGINAL_PRIVATE_SENTINEL",
      original.createdAt,
    ),
  ];
  const body = { ...emptyBody(), items: [original] };
  const state = openWorkflowVault(body.items);
  vi.spyOn(shareReachSeams, "resolveCurrentAccessRole").mockResolvedValue(
    "operator",
  );
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
  const save = vi.spyOn(vaultStore, "saveItem").mockImplementation((item) =>
    writeSavedItems(
      {
        tomb: "personal",
        items: body.items,
        mutate: async (change) => {
          await Promise.resolve();
          withdrawFromBody(body, {
            items: { [original.id]: itemText(original) },
            folderIds: [],
          });
          state.items = body.items;
          change(body);
        },
      },
      [item],
    ),
  );
  await expect(
    comparePrivatePassword(original.id, "CANDIDATE_PRIVATE_SENTINEL", true),
  ).rejects.toThrow("unverified");
  expect(body.items).toEqual([]);
  expect(state.items).toEqual([]);
  expect(save).toHaveBeenCalledTimes(1);
});
it("rejects a changed existing item before any pending writes are applied", async () => {
  const original = createItem("note", "Existing");
  original.notes = "before";
  const updated = { ...original, notes: "pending edit" };
  const created = createItem("note", "New item");
  const body = { ...emptyBody(), items: [original] };
  await expect(
    writeSavedItems(
      {
        tomb: "personal",
        items: body.items,
        mutate: async (change) => {
          await Promise.resolve();
          body.items = [{ ...original, notes: "other committed edit" }];
          change(body);
        },
      },
      [created, updated],
    ),
  ).rejects.toThrow("changed or left");
  expect(body.items).toEqual([{ ...original, notes: "other committed edit" }]);
});
it("preserves creation of a new item through the shared write path", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  const created = createItem("note", "New item");
  const body = emptyBody();
  const committedAt = "2026-10-05T12:00:02.000Z";
  vi.setSystemTime(new Date(committedAt));
  await writeSavedItems(
    {
      tomb: "personal",
      items: [],
      mutate: async (change) => {
        change(body);
      },
    },
    [created],
  );
  expect(body.items).toEqual([{ ...created, updatedAt: committedAt }]);
  expect(body.items[0]?.createdAt).toBe(created.createdAt);
  expect(Date.parse(committedAt)).toBeGreaterThan(
    Date.parse(created.updatedAt),
  );
});
