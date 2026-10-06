import { createItem, emptyBody } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { PASSWORD_WORKFLOW_TOOLS } from "../../webmcp/password-workflow-tools.js";
import { shareReachSeams } from "../local-share-reach.js";
import { itemText, withdrawFromBody } from "./item-departure.js";
import {
  comparePrivatePassword,
  passwordWorkflowFind,
  passwordWorkflowInventory,
  resolveLocalReference,
} from "./password-workflows.js";
import { testAccount } from "./password-workflows.test-support.js";
import type { VaultState } from "./store-state.js";
import { vaultStore } from "./store.js";

afterEach(() => vi.restoreAllMocks());
it("keeps travel-withdrawn items out of discovery and rejects their old read/update references", async () => {
  const hidden = testAccount(
    "Travel private account",
    "TRAVEL_PRIVATE_SENTINEL",
  );
  const visible = createItem("secret", "Visible API");
  visible.value = "VISIBLE_PRIVATE_SENTINEL";
  const body = { ...emptyBody(), items: [hidden, visible] };
  const state: VaultState = {
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    tomb: "personal",
    awaitingSecondStep: false,
    items: body.items,
  };
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
  const save = vi.spyOn(vaultStore, "saveItem").mockResolvedValue(undefined);
  const role = vi
    .spyOn(shareReachSeams, "resolveCurrentAccessRole")
    .mockResolvedValue("operator");
  vi.spyOn(shareReachSeams, "canAccess").mockReturnValue(true);
  // Travel removes the real item from the body while discovery awaits access.
  role.mockImplementationOnce(async () => {
    withdrawFromBody(body, {
      items: { [hidden.id]: itemText(hidden) },
      folderIds: [],
    });
    state.items = body.items;
    return "operator";
  });
  const inventory = await passwordWorkflowInventory();
  expect(inventory.map((item) => item.id)).toEqual([visible.id]);
  expect(JSON.stringify(inventory)).not.toContain(hidden.name);
  expect(JSON.stringify(inventory)).not.toContain("TRAVEL_PRIVATE_SENTINEL");
  expect((await passwordWorkflowFind([hidden.name])).matches).toEqual([]);
  await expect(
    resolveLocalReference(`os://personal/${hidden.id}/password`),
  ).rejects.toThrow("not found");
  await expect(
    comparePrivatePassword(hidden.id, "candidate", true),
  ).rejects.toThrow("active account");
  const inventoryTool = PASSWORD_WORKFLOW_TOOLS.find(
    (tool) => tool.name === "opensesame_vault_inventory",
  );
  const findTool = PASSWORD_WORKFLOW_TOOLS.find(
    (tool) => tool.name === "opensesame_vault_find_references",
  );
  if (!inventoryTool || !findTool)
    throw new Error("Missing workflow metadata tools");
  const metadata = await inventoryTool.execute({});
  const found = await findTool.execute({ queries: [hidden.name] });
  for (const result of [metadata, found]) {
    expect(JSON.stringify(result)).not.toContain(hidden.id);
    expect(JSON.stringify(result)).not.toContain(hidden.name);
    expect(JSON.stringify(result)).not.toContain("TRAVEL_PRIVATE_SENTINEL");
  }
  expect(save).not.toHaveBeenCalled();
});
