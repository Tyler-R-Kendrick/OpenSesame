/**
 * The runner of "Decoy with everyday items": once the decoy session exists,
 * add the owner's items to it as ordinary logins.
 *
 * The items go through the open session's store, which in a decoy is the
 * ephemeral tomb under a throwaway key, wiped when the decoy locks. Nothing
 * here reaches for the vault, a tomb name or the personal scope, and nothing
 * in the plan is derived from it.
 */

import type { JsonValue } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { readDecoyItemsBody } from "./decoy-items-shape.js";
import type { EffectHost, EffectRunner } from "./effects.js";

async function run(body: JsonValue, host: EffectHost): Promise<void> {
  const items = readDecoyItemsBody(body);
  if (!items || !host.store.addItems) return;
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
