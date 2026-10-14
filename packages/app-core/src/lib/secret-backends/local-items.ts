import {
  type AccountItem,
  type VaultItem,
  accountFilePassword,
  createItem,
  manualPassword,
  passwordMethod,
} from "@opensesame/vault-core";
import { FIELD_LIMITS } from "../vault/field-limits.js";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
} from "./types.js";

export type LocalSecretItem = Extract<
  VaultItem,
  { kind: "account" | "secret" | "note" }
>;
export function isLocalSecretItem(item: VaultItem): item is LocalSecretItem {
  return (
    item.deletedAt === null && ["account", "secret", "note"].includes(item.kind)
  );
}
export function localItemView(item: LocalSecretItem): SecretBackendItem {
  const view: SecretBackendItem = {
    id: item.id,
    name: item.name,
    kind: item.kind === "account" ? "login" : item.kind,
    notes: item.notes,
    secret:
      item.kind === "secret"
        ? item.value
        : item.kind === "account"
          ? accountFilePassword(item)
          : "",
    fields: Object.fromEntries(
      item.fields.map((field) => [field.name, field.value]),
    ),
  };
  if (item.kind === "account") {
    view.username = item.username;
    view.url = item.uris[0]?.uri ?? "";
  }
  return view;
}

export function namedLocalItem(
  items: readonly LocalSecretItem[],
  reference: string,
): LocalSecretItem {
  const exact = items.find((item) => item.id === reference);
  if (exact) return exact;
  const matches = items.filter((item) => item.name === reference);
  if (matches.length > 1)
    throw new SecretBackendError(
      "ambiguous",
      "More than one item has that name. Select its item ID.",
    );
  const item = matches[0];
  if (!item)
    throw new SecretBackendError(
      "not-found",
      "That secret item was not found.",
    );
  return item;
}

function validateInput(input: SecretBackendItemInput): void {
  if (!input.name.trim() || input.name.length > FIELD_LIMITS.name)
    throw new SecretBackendError(
      "configuration",
      "Enter an item name of at most 120 characters.",
    );
  if (
    input.notes.length > FIELD_LIMITS.text ||
    input.secret.length > FIELD_LIMITS.text
  )
    throw new SecretBackendError(
      "configuration",
      "That secret or note exceeds the vault field limit.",
    );
}
export function localItemWrite(
  input: SecretBackendItemInput,
  previous?: LocalSecretItem,
): LocalSecretItem {
  validateInput(input);
  const priorKind = previous
    ? previous.kind === "account"
      ? "login"
      : previous.kind
    : "secret";
  const kind = input.kind ?? priorKind;
  const item = previous
    ? structuredClone(previous)
    : createItem(kind === "login" ? "account" : kind, input.name);
  if (!isLocalSecretItem(item))
    throw new SecretBackendError(
      "unsupported",
      "That item type is unavailable through this backend.",
    );
  if ((item.kind === "account" ? "login" : item.kind) !== kind)
    throw new SecretBackendError(
      "unsupported",
      "An existing item's type cannot be changed here.",
    );
  if (item.kind === "note" && input.secret)
    throw new SecretBackendError(
      "unsupported",
      "Put a note's content in its notes field.",
    );
  item.name = input.name.trim();
  item.notes = input.notes;
  if (input.fields)
    item.fields = Object.entries(input.fields).map(([name, value]) => ({
      id:
        item.fields.find((field) => field.name === name)?.id ??
        crypto.randomUUID(),
      name,
      value,
      hidden: true,
    }));
  if (item.kind === "secret") item.value = input.secret;
  if (item.kind === "account") writeLocalAccount(item, input);
  return item;
}

function writeLocalAccount(
  item: AccountItem,
  input: SecretBackendItemInput,
): void {
  if (input.username !== undefined) item.username = input.username;
  if (input.url !== undefined)
    item.uris = input.url
      ? [
          {
            id: item.uris[0]?.id ?? crypto.randomUUID(),
            uri: input.url,
            match: "domain",
          },
          ...item.uris.slice(1),
        ]
      : [];
  const method = passwordMethod(item);
  const password = manualPassword(
    method?.id ?? `${item.id}:password`,
    input.secret,
    new Date().toISOString(),
  );
  item.methods = method
    ? item.methods.map((held) => (held.id === method.id ? password : held))
    : [...item.methods, password];
}
