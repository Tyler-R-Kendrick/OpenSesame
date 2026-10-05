/**
 * The runner of "Decoy with everyday items": once the decoy session exists,
 * add the owner's items to it as ordinary accounts.
 *
 * The items go through the open session's store, which in a decoy is the
 * ephemeral tomb under a throwaway key, wiped when the decoy locks. Nothing
 * here reaches for the vault, a tomb name or the personal scope, and nothing
 * in the plan is derived from it.
 */

import type { JsonValue } from "@opensesame/os-domain";
import { createItem, manualPassword } from "@opensesame/vault-core";
import { readDecoyItemsBody } from "./decoy-items-shape.js";
import type { EffectHost, EffectRunner } from "./effects.js";

async function run(body: JsonValue, host: EffectHost): Promise<void> {
  const items = readDecoyItemsBody(body);
  if (!items || !host.store.addItems) return;
  const accounts = items.map(({ title, secret }) => {
    const account = createItem("account", title);
    account.methods = [
      manualPassword(`${account.id}:password`, secret, account.createdAt),
    ];
    return account;
  });
  await host.store.addItems(accounts);
}

export const DECOY_ITEMS_RUNNER: EffectRunner = {
  phase: "after_session",
  run,
};
