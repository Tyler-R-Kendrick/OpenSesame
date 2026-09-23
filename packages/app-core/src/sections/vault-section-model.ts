import { isString } from "@opensesame/os-domain";
/**
 * View-model logic for `VaultSection` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  type VaultItem,
  definitionFor,
  itemTypeId,
  itemTypeRegistry,
  readItemField,
} from "@opensesame/vault-core";

/**
 * The filter chips, in registry order (built-ins first), for the types this
 * vault actually holds and every type installed into it. Derived rather than
 * listed: a plugin-defined type is a type like any other, so it earns its own
 * chip the moment it is installed, as it earns its own rail directory (ADR
 * 0087 §1). A hardcoded list would quietly bucket every community type into
 * one undifferentiated pile.
 */
export function chipTypeIds(live: readonly VaultItem[]): readonly string[] {
  const present = new Set(live.map(itemTypeId));
  const ordered = itemTypeRegistry()
    .list()
    .filter(
      ({ definition, source }) =>
        source !== "builtin" || present.has(definition.metadata.id),
    )
    .map(({ definition }) => definition.metadata.id);
  // A type whose definition is not installed here still deserves its chip;
  // the label falls back to the id rather than the item vanishing from view.
  const orphans = [...present].filter((id) => !itemTypeRegistry().has(id));
  return [...ordered, ...orphans.sort()];
}

/** Any registered type may be the one a filtered "+ new" creates. */
export function concealedValue(item: VaultItem): string | null {
  if (item.kind === "login") return item.password;
  if (item.kind === "secret") return item.value;
  if (item.kind === "card") return item.number;
  if (item.kind === "certificate") return item.privateKeyPem;
  // A plugin-defined type already says which field is its secret — the same
  // field that becomes line one of its native entry (ADR 0087 §3).
  const definition = definitionFor(item);
  const secretField = definition?.spec.native.secret;
  if (
    definition === undefined ||
    secretField === undefined ||
    secretField === null
  ) {
    return null;
  }
  const field = definition.spec.sections
    .flatMap((section) => section.fields)
    .find((candidate) => candidate.id === secretField);
  if (field === undefined) return null;
  const value = readItemField(item, field);
  return isString(value) && value !== "" ? value : null;
}

export function username(item: VaultItem): string | null {
  return item.kind === "login" || item.kind === "passkey"
    ? item.username
    : null;
}
