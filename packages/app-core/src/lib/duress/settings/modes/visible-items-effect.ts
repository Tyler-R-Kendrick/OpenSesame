/**
 * The runner of "Show my vault without the items I hide": once the decoy
 * session exists, add the copies sealed with the code to it as ordinary items.
 *
 * Every copy gets an id of its own, drawn here at unlock, so nothing in the
 * decoy carries an id the real vault holds. The items go through the open
 * session's store, which in a decoy is the ephemeral tomb under a throwaway
 * key, wiped when the decoy locks. Nothing here reaches for the vault, a tomb
 * name or the personal scope, and nothing the plan carries is derived from the
 * vault's key: the copies were taken at arming, with the vault open, and were
 * sealed under the duress code alone.
 */

import type { JsonValue } from "@opensesame/os-domain";
import {
  type AccountItem,
  type CustomField,
  type TypedItem,
  type VaultItem,
  createItem,
  manualPassword,
  newId,
  newUri,
} from "@opensesame/vault-core";
import type { EffectHost, EffectRunner } from "./effects.js";
import {
  type SharedItem,
  readVisibleItemsBody,
} from "./visible-items-shape.js";

/** An item as the vault holds it, from its copy: the same content, a new id, no folder. */
export function materialize(shared: SharedItem): VaultItem {
  const fields: CustomField[] = shared.fields.map((field) => ({
    id: newId(),
    name: field.name,
    value: field.value,
    hidden: field.hidden,
  }));
  const common = {
    name: shared.name,
    favorite: shared.favorite,
    notes: shared.notes,
    fields,
    createdAt: shared.createdAt,
    updatedAt: shared.updatedAt,
  };
  switch (shared.kind) {
    case "login": {
      // A copy's `login` is an account holding one typed password.
      const account = createItem("account", shared.name);
      const made: AccountItem = {
        ...account,
        ...common,
        username: shared.username,
        uris: shared.uris.map((entry) => newUri(entry.uri, entry.match)),
        methods: [
          manualPassword(
            `${account.id}:password`,
            shared.password,
            shared.passwordChangedAt,
          ),
        ],
      };
      return made;
    }
    case "note":
      return { ...createItem("note", shared.name), ...common };
    case "secret":
      return {
        ...createItem("secret", shared.name),
        ...common,
        value: shared.value,
      };
    case "card":
      return {
        ...createItem("card", shared.name),
        ...common,
        cardholder: shared.cardholder,
        brand: shared.brand,
        number: shared.number,
        expMonth: shared.expMonth,
        expYear: shared.expYear,
        code: shared.code,
      };
    case "typed": {
      const typed: TypedItem = {
        ...createItem("note", shared.name),
        ...common,
        kind: "typed",
        typeId: shared.typeId,
        values: { ...shared.values },
      };
      return typed;
    }
  }
}

async function run(body: JsonValue, host: EffectHost): Promise<void> {
  const shared = readVisibleItemsBody(body);
  if (!shared || !host.store.addItems) return;
  await host.store.addItems(shared.map(materialize));
}

export const VISIBLE_ITEMS_RUNNER: EffectRunner = {
  phase: "after_session",
  run,
};
