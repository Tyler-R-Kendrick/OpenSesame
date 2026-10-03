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

/** Text cut to `max` characters, with a mark where it was cut when asked. */
function cut(text: string, max: number, marked: boolean): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return marked
    ? `${chars.slice(0, Math.max(0, max - 1)).join("")}\u2026`
    : chars.slice(0, max).join("");
}

function sharedField(field: Held, valueMax: number): SharedField {
  return {
    key: field.key,
    label: clip(field.label, LABEL_MAX),
    concealed: field.concealed,
    // Shorter than the usual cap only to fit the frame: say so in the text, so
    // a guest who copies it does not take a cut value for the whole one.
    value: field.concealed
      ? null
      : cut(field.text, valueMax, valueMax < VALUE_MAX),
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
 * What the catalog frame may weigh, in bytes. A data channel carries one
 * message at a time, and Chromium's limit is 256 KiB (`a=max-message-size`),
 * past which `send` throws, so `peer.ts` sends at most `FRAME_BYTES` and the
 * catalog is cut to fit under it, with room for the envelope. 200 items of 32
 * fields with 16 KiB of text each is far past that. Unconcealed text is
 * clipped shorter, in steps and marked where it was cut, and only if names
 * alone still do not fit are the last items left out (a joiner is never shown
 * an item it could not reveal from, and the owner's own checks use this same
 * catalog).
 */
export const CATALOG_BUDGET = 200_000;
const VALUE_STEPS = [VALUE_MAX, 1024, 128];
const encoder = new TextEncoder();

function weight(catalog: Catalog): number {
  return encoder.encode(JSON.stringify({ t: "catalog", catalog })).length;
}

/** Characters in every string of a catalog, with a little for each field. */
function characterCount(catalog: Catalog): number {
  let total = catalog.title.length + 80;
  for (const item of catalog.items) {
    total += item.name.length + item.type.length + 80;
    for (const field of item.fields)
      total +=
        field.key.length + field.label.length + (field.value?.length ?? 0) + 80;
  }
  return total;
}

/** Whether a catalog certainly fits: three bytes covers any one UTF-16 unit. */
function certainlyFits(catalog: Catalog): boolean {
  return characterCount(catalog) * 3 <= CATALOG_BUDGET;
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
    if (certainlyFits(whole) || weight(whole) <= CATALOG_BUDGET) return whole;
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

/**
 * The fitted catalog for a vault as it stands: the owner asks for it on every
 * attach, reveal, copy and edit, and fitting a big vault is not free, so what
 * was fitted is kept for as long as the vault's items are the same array.
 */
const remembered = new WeakMap<readonly VaultItem[], Map<string, Catalog>>();

export type CatalogInput = Readonly<{
  title: string;
  policy: SharePolicy;
  expiresAt: number;
  scope: ShareScope;
  items: () => readonly VaultItem[];
}>;

/** The catalog a joiner is sent: names, types, and unconcealed fields. */
export function vaultCatalog(input: CatalogInput): Catalog {
  const held = input.items();
  const head = {
    title: clip(input.title, LABEL_MAX),
    policy: input.policy,
    expiresAt: input.expiresAt,
  };
  const key = JSON.stringify([head, input.scope]);
  const byKey = remembered.get(held) ?? new Map<string, Catalog>();
  const known = byKey.get(key);
  if (known) return known;
  const catalog = fitted(head, sharedItems(held, input.scope));
  byKey.set(key, catalog);
  remembered.set(held, byKey);
  return catalog;
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
