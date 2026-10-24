/** Put the HoneyVault decoy credentials into the ephemeral decoy vault. */
import type { JsonValue } from "@opensesame/os-domain";
import { createItem, manualPassword } from "@opensesame/vault-core";
import type { EffectHost, EffectRunner } from "./effects.js";
import { honeyVaultRecords } from "./honey-vault.js";

async function run(body: JsonValue, host: EffectHost): Promise<void> {
  const items = honeyVaultRecords(body);
  if (items.length === 0 || !host.store.addItems) return;
  await host.store.addItems(
    items.map(({ title, token }) => {
      const account = createItem("account", title);
      account.methods = [
        manualPassword(`${account.id}:password`, token, account.createdAt),
      ];
      return account;
    }),
  );
}

export const HONEY_VAULT_RUNNER: EffectRunner = {
  phase: "after_session",
  run,
};
