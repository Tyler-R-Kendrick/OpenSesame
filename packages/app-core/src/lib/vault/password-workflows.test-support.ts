import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountItem,
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
  extractEmbeddedMethods,
  manualPassword,
  resolveAccounts,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import { createNodeHost } from "../../node/host.js";
import { kvFlush, kvForgetAll } from "../kv.js";
import { vfsFlush } from "../vfs.js";
import { stampedEdit } from "./body-edits.js";
import { writeItem } from "./item-path.js";
import type { VaultState } from "./store-state.js";
import { vaultStore } from "./store.js";
export function testAccount(name: string, secret = ""): AccountItem {
  const account = createItem("account", name);
  account.methods = [
    manualPassword(`${account.id}:password`, secret, account.updatedAt),
  ];
  return account;
}
/** The body a vault holds for `items`: an account's methods are entries of their own (ADR 0179). */
export function sealedBody(items: readonly VaultItem[]): VaultBody {
  return { ...emptyBody(), items: extractEmbeddedMethods(items) };
}
/** What the store's snapshot reads out of a body. */
export function readBody(body: VaultBody): VaultItem[] {
  return resolveAccounts(body.items);
}
export function openWorkflowVault(items: VaultItem[]): VaultState {
  const state: VaultState = {
    ...vaultStore.getSnapshot(),
    status: "unlocked",
    tomb: "personal",
    awaitingSecondStep: false,
    items,
  };
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => state);
  vi.spyOn(vaultStore, "saveItem").mockImplementation(async (item) => {
    const body = sealedBody(state.items);
    stampedEdit((draft) => writeItem(draft, item))(body);
    // The store's snapshot is the resolved view (ADR 0179).
    state.items = readBody(body);
  });
  return state;
}

let previousHost: ReturnType<typeof host>;
let directory: string;
beforeEach(async () => {
  await vfsFlush();
  await kvFlush();
  previousHost = host();
  directory = await mkdtemp(join(tmpdir(), "workflow-admitted-root-"));
  configureHost(createNodeHost({ stateDir: directory }));
  kvForgetAll();
  vaultStore.lock();
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("actual admitted workflow fixture password");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  configureHost(previousHost);
  await rm(directory, { recursive: true, force: true });
});
