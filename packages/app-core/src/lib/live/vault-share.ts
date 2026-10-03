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

function sharedField(field: Held, valueMax: number): SharedField {
  return {
    key: field.key,
    label: clip(field.label, LABEL_MAX),
    concealed: field.concealed,
    value: field.concealed ? null : clip(field.text, valueMax),
  };
}

function sharedItem(item: VaultItem, valueMax: number): SharedItem {
  return {
    id: item.id,
    name: clip(item.name, LABEL_MAX),
    type: clip(itemTypeId(item), 128),
    fields: heldFields(item).map((field) => sharedField(field, valueMax)),
  };
}

/**
 * What the catalog frame may weigh. The channel carries one frame of at most
 * 1 MiB (`peer.ts`); 200 items of 32 fields with 16 KiB of text each is far
 * past that, and a frame over the cap never arrives. The catalog is cut to
 * fit instead: unconcealed text is clipped shorter, and only if names alone
 * still do not fit are the last items left out (a joiner is never shown an
 * item it could not reveal from, and the owner's own checks use this same
 * catalog).
 */
export const CATALOG_BUDGET = 900 * 1024;
const VALUE_STEPS = [VALUE_MAX, 1024, 128];

function weight(catalog: Catalog): number {
  return JSON.stringify({ t: "catalog", catalog }).length;
}

function fitted(
  head: Pick<Catalog, "title" | "policy" | "expiresAt">,
  items: readonly VaultItem[],
): Catalog {
  const build = (valueMax: number, count: number): Catalog => ({
    ...head,
    items: items.slice(0, count).map((item) => sharedItem(item, valueMax)),
  });
  for (const valueMax of VALUE_STEPS) {
    const whole = build(valueMax, items.length);
    if (weight(whole) <= CATALOG_BUDGET) return whole;
  }
  const shortest = VALUE_STEPS[VALUE_STEPS.length - 1] ?? 0;
  let fits = 0;
  let over = items.length;
  while (fits < over) {
    const middle = Math.ceil((fits + over) / 2);
    if (weight(build(shortest, middle)) <= CATALOG_BUDGET) fits = middle;
    else over = middle - 1;
  }
  return build(shortest, fits);
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
  return fitted(
    {
      title: clip(input.title, LABEL_MAX),
      policy: input.policy,
      expiresAt: input.expiresAt,
    },
    sharedItems(input.items(), input.scope),
  );
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
