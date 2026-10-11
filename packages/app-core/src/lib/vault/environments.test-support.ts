/**
 * Shared set-up for the environments model tests: vaults built from secrets,
 * and the edits applied to them, the way the store applies them.
 */

import {
  type SecretItem,
  type VaultBody,
  type VaultItem,
  createItem,
  emptyBody,
} from "@opensesame/vault-core";
import { applyEnvironmentsEdit } from "./body-environments.js";
import { type SchemaKey, schemaKeys } from "./environments.js";

export const T0 = "2026-01-01T00:00:00.000Z";

export function item(
  id: string,
  name: string,
  createdAt = T0,
  extra: Partial<SecretItem> = {},
): VaultItem {
  const base = createItem("secret", name);
  if (base.kind !== "secret") throw new Error("not a secret");
  return { ...base, id, createdAt, updatedAt: createdAt, ...extra };
}

export function vault(items: VaultItem[], ...names: string[]): VaultBody {
  const body: VaultBody = { ...emptyBody(), items };
  for (const [index, name] of names.entries()) {
    applyEnvironmentsEdit(
      body,
      { op: "add-environment", name },
      new Date(Date.parse(T0) + index * 1000),
    );
  }
  return body;
}

export function edit(
  body: VaultBody,
  ...edits: Parameters<typeof applyEnvironmentsEdit>[1][]
) {
  for (const next of edits) applyEnvironmentsEdit(body, next);
}

export function keysOf(body: VaultBody): SchemaKey[] {
  return schemaKeys(body.items);
}
