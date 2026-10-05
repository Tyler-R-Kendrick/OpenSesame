/**
 * The runner of "Decoy with everyday items": once the decoy session exists,
 * add the owner's items to it as ordinary logins.
 *
 * The items go through the open session's store, which in a decoy is the
 * ephemeral tomb under a throwaway key, wiped when the decoy locks. Nothing
 * here reaches for the vault, a tomb name or the personal scope, and nothing
 * in the plan is derived from it.
 */

import { type LoginItem, createItem } from "@opensesame/vault-core";
import { readDecoyItemsBody } from "./decoy-items-shape.js";
import type { EffectHost, EffectRunner } from "./effects.js";

type ItemStore = Readonly<{
  addItems: (items: LoginItem[]) => Promise<void>;
}>;

function canAddItems(store: object): store is ItemStore {
  return typeof (store as Partial<ItemStore>).addItems === "function";
}

async function run(body: unknown, host: EffectHost): Promise<void> {
  const items = readDecoyItemsBody(body);
  if (!items || !canAddItems(host.store)) return;
  const logins = items.map(({ title, secret }) => {
    const login = createItem("login", title);
    login.password = secret;
    return login;
  });
  await host.store.addItems(logins);
}

export const DECOY_ITEMS_RUNNER: EffectRunner = {
  phase: "after_session",
  run,
};
