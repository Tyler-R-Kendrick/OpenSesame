import { configureHost } from "@opensesame/app-core/host.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { WebStorage } from "@opensesame/app-core/ports.js";
import {
  type AccountItem,
  type PasswordMethod,
  activeItems,
  passwordMethod,
  producePassword,
} from "@opensesame/vault-core";
import { readPasswordFromTty } from "./tty-password.js";
import { createAvailableCliVaultHost } from "./vault-host.js";
import { ensureVault } from "./vault-items.js";
import { useVaultKv } from "./vault-kv.js";

export type ResetVault = {
  store: VaultStore;
  item: AccountItem;
  method: PasswordMethod;
  local: WebStorage;
};

export type ResetVaultDependencies = {
  stateDir?: string;
  readPassword?: (prompt: string) => Promise<string>;
};

export async function openResetVault(
  itemId: string,
  deps: ResetVaultDependencies,
): Promise<ResetVault> {
  const stateDir = deps.stateDir ?? process.env.OPENSESAME_AGENT_STATE_DIR;
  if (!stateDir)
    throw new Error(
      "OPENSESAME_AGENT_STATE_DIR must name the agent-dedicated vault",
    );
  await useVaultKv(stateDir);
  const host = await createAvailableCliVaultHost(stateDir);
  if (!host.storage?.local)
    throw new Error("Sealed local storage is required for password reset");
  configureHost(host);
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  vaultStore.lock();
  vaultStore.rehydrate();
  await ensureVault(
    vaultStore,
    {
      readPassword: deps.readPassword ?? readPasswordFromTty,
    },
    false,
  );
  const item = activeItems([...vaultStore.getSnapshot().items]).find(
    (candidate) => candidate.id === itemId,
  );
  if (!item) throw new Error("The exact reset vault item was not found");
  if (item.kind !== "account")
    throw new Error("A password reset requires an account item");
  const method = passwordMethod(item);
  if (!method || producePassword(method).status !== "slotted")
    throw new Error(
      "The account needs an algorithmic password with a pepper slot",
    );
  return { store: vaultStore, item, method, local: host.storage.local };
}
