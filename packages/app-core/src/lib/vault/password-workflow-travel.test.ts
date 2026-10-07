import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createItem, emptyBody } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { createNodeHost } from "../../node/host.js";
import { PASSWORD_WORKFLOW_TOOLS } from "../../webmcp/password-workflow-tools.js";
import { kvFlush, kvForgetAll } from "../kv.js";
import { shareReachSeams } from "../local-share-reach.js";
import { createProject, setActiveProject } from "../projects.js";
import {
  enrollRetiredCredential,
  flushRetiredCredentialTelemetry,
} from "../retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { vfsFlush } from "../vfs.js";
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

it.each(["retired", "ordinary", "owner-ABA"] as const)(
  "keeps %s admission out of an in-flight private workflow",
  async (transition) => {
    await vfsFlush();
    await kvFlush();
    const previous = host();
    const directory = await mkdtemp(join(tmpdir(), "password-workflow-realm-"));
    const password = "actual workflow owner password";
    const retired = "actual workflow retired password";
    configureHost(createNodeHost({ stateDir: directory }));
    kvForgetAll();
    vaultStore.loadActiveProjectScope();
    let release = () => {};
    let pending: Promise<string | Error> | undefined;
    try {
      await vaultStore.create(password);
      const secret = createItem("secret", "Real workflow credential");
      secret.value = "REAL_WORKFLOW_PRIVATE_SENTINEL";
      await vaultStore.addItems([secret]);
      const reference = `os://${vaultStore.activeTomb()}/${secret.id}/value`;
      await expect(resolveLocalReference(reference)).resolves.toBe(
        secret.value,
      );
      await enrollRetiredCredential({
        tomb: vaultStore.activeTomb(),
        currentPassword: password,
        retiredPassword: retired,
        response: "synthetic_decoy",
        acknowledgePasswordVerifierRisk: true,
      });
      const realRole = shareReachSeams.resolveCurrentAccessRole;
      let reached = () => {};
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(
        shareReachSeams,
        "resolveCurrentAccessRole",
      ).mockImplementationOnce(async (tomb) => {
        const role = await realRole(tomb);
        reached();
        await held;
        return role;
      });
      pending = resolveLocalReference(reference).catch((error: Error) => error);
      await started;
      vaultStore.lock();
      if (transition === "retired") {
        await expect(
          unlockWithRetiredCredentialGate(vaultStore, retired),
        ).resolves.toBe("retired_credential_session");
        await expect(resolveLocalReference(reference)).rejects.toThrow();
        const inventoryTool = PASSWORD_WORKFLOW_TOOLS.find(
          (tool) => tool.name === "opensesame_vault_inventory",
        );
        if (!inventoryTool) throw new Error("Missing inventory tool");
        await expect(inventoryTool.execute({})).rejects.toThrow();
        await flushRetiredCredentialTelemetry();
        vaultStore.lock();
      } else if (transition === "owner-ABA") {
        const second = await createProject("Actual second workflow owner");
        await setActiveProject(second.id);
        vaultStore.loadActiveProjectScope();
        await vaultStore.create("actual distinct second workflow password");
        vaultStore.lock();
        await setActiveProject("personal");
        vaultStore.loadActiveProjectScope();
      }
      await unlockWithRetiredCredentialGate(vaultStore, password);
      release();
      expect(await pending).toBeInstanceOf(Error);
      await expect(resolveLocalReference(reference)).resolves.toBe(
        secret.value,
      );
    } finally {
      release();
      await pending;
      vaultStore.lock();
      await flushRetiredCredentialTelemetry();
      await vfsFlush();
      await kvFlush();
      kvForgetAll();
      configureHost(previous);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
