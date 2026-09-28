/**
 * What an owner's open vault shows a live session (ADR 0150 §5).
 *
 * The catalog is built from the vault as it stands at each call, so an item
 * edited, deleted or taken out of the scope mid-session is reflected on the
 * next request — and a request is always answered against the vault now, not
 * against what the joiner was once shown. A field's concealment is the item
 * type's own (`isConcealedFieldType`) or a custom field's `hidden`; notes are
 * treated as concealed, because people keep secrets in them.
 *
 * Everything is clamped to the wire's bounds here, so an unusually large
 * vault produces a smaller catalog, never one the joiner has to refuse whole.
 */

import {
  type VaultItem,
  activeItems,
  definitionFor,
  itemTypeId,
  readItemField,
} from "@opensesame/vault-core";
import {
  definitionFields,
  displayText,
  isConcealedFieldType,
} from "@opensesame/vault-item-types";
import {
  type Catalog,
  MAX_FIELDS,
  MAX_ITEMS,
  type SharePolicy,
  type SharedField,
  type SharedItem,
  VALUE_MAX,
} from "./messages.js";

const LABEL_MAX = 120;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type ShareScope =
  | Readonly<{ kind: "vault" }>
  | Readonly<{ kind: "items"; ids: readonly string[] }>;

/** A field as the owner holds it: its label, concealment and full text. */
type Held = Readonly<{
  key: string;
  label: string;
  concealed: boolean;
  text: string;
}>;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

function heldFields(item: VaultItem): Held[] {
  const held: Held[] = [];
  const definition = definitionFor(item);
  for (const field of definition ? definitionFields(definition) : []) {
    const text = displayText(field, readItemField(item, field));
    if (text === "") continue;
    held.push({
      key: field.id,
      label: field.label,
      concealed: isConcealedFieldType(field.type),
      text,
    });
  }
  for (const custom of item.fields) {
    if (custom.value === "") continue;
    held.push({
      key: `custom:${custom.id}`,
      label: custom.name,
      concealed: custom.hidden,
      text: custom.value,
    });
  }
  if (item.notes.trim() !== "")
    held.push({
      key: "notes",
      label: "Notes",
      concealed: true,
      text: item.notes,
    });
  return held.filter((field) => ID.test(field.key)).slice(0, MAX_FIELDS);
}

function inScope(scope: ShareScope, item: VaultItem): boolean {
  return scope.kind === "vault" || scope.ids.includes(item.id);
}

/** The items a scope reaches, in the vault as it stands. */
export function sharedItems(
  items: readonly VaultItem[],
  scope: ShareScope,
): VaultItem[] {
  return activeItems([...items])
    .filter((item) => ID.test(item.id) && inScope(scope, item))
    .slice(0, MAX_ITEMS);
}

function sharedField(field: Held): SharedField {
  return {
    key: field.key,
    label: clip(field.label, LABEL_MAX),
    concealed: field.concealed,
    value: field.concealed ? null : clip(field.text, VALUE_MAX),
  };
}

function sharedItem(item: VaultItem): SharedItem {
  return {
    id: item.id,
    name: clip(item.name, LABEL_MAX),
    type: clip(itemTypeId(item), 128),
    fields: heldFields(item).map(sharedField),
  };
}

export type CatalogInput = Readonly<{
  title: string;
  policy: SharePolicy;
  expiresAt: number;
  scope: ShareScope;
  items: () => readonly VaultItem[];
}>;

/** The catalog a joiner is sent: names, types, and unconcealed fields. */
export function vaultCatalog(input: CatalogInput): Catalog {
  return {
    title: clip(input.title, LABEL_MAX),
    policy: input.policy,
    expiresAt: input.expiresAt,
    items: sharedItems(input.items(), input.scope).map(sharedItem),
  };
}

/** One field's full text, if the item is still shared and the field exists. */
export function vaultField(
  input: Pick<CatalogInput, "scope" | "items">,
): (item: string, field: string) => Promise<string | null> {
  return async (itemId, key) => {
    const item = sharedItems(input.items(), input.scope).find(
      (entry) => entry.id === itemId,
    );
    const held = item
      ? heldFields(item).find((field) => field.key === key)
      : undefined;
    return held ? held.text : null;
  };
}
