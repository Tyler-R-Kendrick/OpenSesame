/**
 * The writes environments make to a vault body (ADR 0194): a closed set of
 * edits, each applied inside the one sealed write the store runs for it.
 *
 * It is a closed set on purpose. `VaultStore.editEnvironments` takes one of
 * these, not a function over the body, so a capability that edits
 * environments is handed exactly that and no more. Each edit is validated
 * against the body it lands on; one that does not fit throws, and the store
 * rolls the write back, so memory never runs ahead of disk.
 */

import { overlapCast } from "@opensesame/os-domain";
import {
  type EnvironmentCell,
  type ItemEnvironments,
  type VaultBody,
  type VaultItem,
  canBeKey,
  cellOf,
  environmentNames,
  isEnvironmentName,
} from "@opensesame/vault-core";

export type EnvironmentsEdit =
  | Readonly<{ op: "add-environment"; name: string }>
  | Readonly<{ op: "remove-environment"; name: string }>
  | Readonly<{ op: "add-key"; itemId: string }>
  | Readonly<{ op: "remove-key"; itemId: string }>
  | Readonly<{
      op: "set-cell";
      itemId: string;
      environment: string;
      /** Only the fields present change. An empty value or `false` unsets. */
      cell: Readonly<{ value?: string; required?: boolean }>;
    }>;

function withEnvironments(
  item: VaultItem,
  environments: ItemEnvironments | undefined,
): VaultItem {
  const { environments: _was, ...rest } = item;
  // The key is added or left out, never set to undefined, so a sealed body
  // never carries an explicit null.
  return overlapCast(
    environments === undefined ? rest : { ...rest, environments },
  );
}

function mapItem(
  body: VaultBody,
  itemId: string,
  change: (item: VaultItem) => VaultItem,
): void {
  const found = body.items.some((item) => item.id === itemId);
  if (!found) throw new Error("That item is not in this vault.");
  body.items = body.items.map((item) =>
    item.id === itemId ? change(item) : item,
  );
}

function assertLive(body: VaultBody, name: string): void {
  if (!environmentNames(body.environments).includes(name)) {
    throw new Error(`There is no environment called ${name}.`);
  }
}

/** The cell after a patch: a field set, or left out when it is empty or false. */
function patched(
  was: EnvironmentCell | undefined,
  patch: Readonly<{ value?: string; required?: boolean }>,
): EnvironmentCell {
  const value = patch.value ?? was?.value;
  const required = patch.required ?? was?.required;
  return {
    ...(value ? { value } : undefined),
    ...(required ? { required: true as const } : undefined),
  };
}

function addEnvironment(body: VaultBody, name: string, at: string): void {
  if (!isEnvironmentName(name)) {
    throw new Error(
      "An environment name is lower-case words joined by - _ or .",
    );
  }
  if (environmentNames(body.environments).includes(name)) return;
  body.environments = { ...body.environments, [name]: { at } };
}

function removeEnvironment(body: VaultBody, name: string, at: string): void {
  if (!environmentNames(body.environments).includes(name)) return;
  body.environments = { ...body.environments, [name]: { at, removed: true } };
  // Its values go with it, in this same write: a name that is gone must not
  // leave a secret behind in every key.
  body.items = body.items.map((item) => {
    if (!item.environments || cellOf(item.environments, name) === undefined) {
      return item;
    }
    const { [name]: _dropped, ...rest } = item.environments;
    return withEnvironments(item, rest);
  });
}

export function applyEnvironmentsEdit(
  body: VaultBody,
  edit: EnvironmentsEdit,
  now: Date = new Date(),
): void {
  const at = now.toISOString();
  switch (edit.op) {
    case "add-environment":
      addEnvironment(body, edit.name, at);
      break;
    case "remove-environment":
      removeEnvironment(body, edit.name, at);
      break;
    case "add-key":
      mapItem(body, edit.itemId, (item) => {
        if (!canBeKey(item)) throw new Error("That item cannot be a key.");
        return item.environments ? item : withEnvironments(item, {});
      });
      break;
    case "remove-key":
      mapItem(body, edit.itemId, (item) =>
        item.environments ? withEnvironments(item, undefined) : item,
      );
      break;
    case "set-cell":
      assertLive(body, edit.environment);
      mapItem(body, edit.itemId, (item) => {
        if (!item.environments) throw new Error("That item is not a key.");
        return withEnvironments(item, {
          ...item.environments,
          [edit.environment]: patched(
            cellOf(item.environments, edit.environment),
            edit.cell,
          ),
        });
      });
      break;
  }
}
