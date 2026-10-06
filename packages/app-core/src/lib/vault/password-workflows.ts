import { isString } from "@opensesame/os-domain";
/** Human workflow adapter; metadata discovery shares the native provider algorithms. */
import {
  type SecretItem,
  type VaultItem,
  createItem,
  definitionFor,
  itemTypeId,
  outsideAccounts,
  readItemField,
} from "@opensesame/vault-core";
import {
  definitionFields,
  isConcealedFieldType,
} from "@opensesame/vault-item-types";
import { assertShareReach } from "../local-share-reach.js";
import {
  type InventoryItem,
  auditInventory,
  findInItems,
  hasTransientUrl,
  metadataOrigin,
} from "../password-agent/discover.js";
import { resolveEnv } from "../password-agent/env.js";
import {
  accountFieldMetadata,
  accountSecretField,
  matchesWrittenAccount,
  privatePasswordValue,
  selectedPassword,
  withPrivatePassword,
} from "./password-workflow-account.js";
import { vaultStore } from "./store.js";

export function localReference(
  tomb: string,
  item: string,
  field: string,
): string {
  return `os://${encodeURIComponent(tomb)}/${encodeURIComponent(item)}/${encodeURIComponent(field)}`;
}
export function localInventory(
  tomb: string,
  items: readonly VaultItem[],
): InventoryItem[] {
  return items
    .filter((item) => item.deletedAt === null)
    .map((item) => ({
      id: item.id,
      title: item.name,
      vault: tomb,
      kind:
        item.kind === "secret"
          ? "api-credential"
          : item.kind === "note"
            ? "secure-note"
            : itemTypeId(item),
      tags: [],
      urls: [...new Set(rawMetadataUrls(item).map(metadataOrigin))].filter(
        Boolean,
      ),
      urlsNeedReview: rawMetadataUrls(item).some(hasTransientUrl),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      fields: [
        ...declaredFieldMetadata(tomb, item),
        ...item.fields.map((field) => {
          const metadata: InventoryItem["fields"][number] = {
            label: field.name,
            type: field.hidden ? "concealed" : "string",
          };
          if (
            field.hidden &&
            field.value.length > 0 &&
            !(
              item.kind === "account" &&
              (field.id === "password" || field.id.startsWith("method:"))
            )
          )
            metadata.ref = localReference(tomb, item.id, field.id);
          return metadata;
        }),
      ],
    }))
    .sort(
      (a, b) =>
        a.vault.localeCompare(b.vault) || a.title.localeCompare(b.title),
    );
}
function rawMetadataUrls(item: VaultItem): string[] {
  const urls = item.kind === "account" ? item.uris.map(({ uri }) => uri) : [];
  for (const field of item.fields) {
    if (!field.hidden && field.id === "url") urls.push(field.value);
  }
  if (item.kind === "account")
    for (const method of item.methods) {
      if (method.type === "oauth") urls.push(method.tokenUrl);
    }
  const definition = definitionFor(item);
  if (definition)
    for (const field of definitionFields(definition)) {
      if (field.type !== "url") continue;
      const value = readItemField(item, field);
      if (isString(value)) urls.push(value);
    }
  return [...new Set(urls)].filter(Boolean);
}
function declaredFieldMetadata(
  tomb: string,
  item: VaultItem,
): InventoryItem["fields"] {
  if (item.kind === "account")
    return accountFieldMetadata(item, (field) =>
      localReference(tomb, item.id, field),
    );
  const definition = definitionFor(item);
  if (!definition) {
    if (item.kind === "secret")
      return [
        {
          label: "credential",
          type: "concealed",
          ref: localReference(tomb, item.id, "value"),
        },
      ];
    return [];
  }
  return definitionFields(definition).map((field) => {
    const metadata: InventoryItem["fields"][number] = {
      label: field.label,
      type: isConcealedFieldType(field.type) ? "concealed" : field.type,
    };
    if (field.type === "password") metadata.purpose = "password";
    const value = readItemField(item, field);
    if (isConcealedFieldType(field.type) && isString(value) && value.length > 0)
      metadata.ref = localReference(tomb, item.id, field.id);
    return metadata;
  });
}

function unlocked() {
  const state = vaultStore.getSnapshot();
  if (state.status !== "unlocked" || state.awaitingSecondStep)
    throw new Error("Unlock the vault first.");
  return state;
}
async function reachableItems() {
  const state = unlocked();
  const items: VaultItem[] = [];
  // A credential bound to an account is that account's method, referenced
  // through it (`method:<id>:secret`), not an item of its own to find (ADR 0179).
  for (const item of outsideAccounts(state.items)) {
    if (item.deletedAt !== null) continue;
    try {
      await assertShareReach(state.tomb, { kind: "item", id: item.id }, "read");
      items.push(item);
    } catch {
      /* Unreachable items stay out of discovery. */
    }
  }
  const current = unlocked();
  if (current.tomb !== state.tomb)
    throw new Error("The vault changed. Try again.");
  const stillPresent = outsideAccounts(current.items).filter(
    (entry) =>
      entry.deletedAt === null &&
      items.some(
        (item) => item.id === entry.id && item.updatedAt === entry.updatedAt,
      ),
  );
  return { tomb: state.tomb, items: stillPresent };
}
export async function passwordWorkflowInventory() {
  const { tomb, items } = await reachableItems();
  return localInventory(tomb, items);
}
export async function passwordWorkflowFind(queries: readonly string[]) {
  if (!queries.length || queries.some((query) => !query.trim()))
    throw new Error("Enter at least one title query.");
  return findInItems(queries, await passwordWorkflowInventory());
}
export async function passwordWorkflowAudit() {
  return auditInventory(await passwordWorkflowInventory());
}
export type CredentialMetadata = { url?: string; notes?: string };
export async function createPrivateCredential(
  title: string,
  sourceValue: string,
  metadata: CredentialMetadata = {},
) {
  const state = unlocked();
  const value = sourceValue.replace(/\r?\n$/, "");
  if (
    state.items.some(
      (item) =>
        item.deletedAt === null &&
        item.name.trim().toLowerCase() === title.trim().toLowerCase(),
    )
  )
    throw new Error(
      "An item with this title already exists; nothing was created.",
    );
  if (!title.trim() || !value.trim())
    throw new Error("A title and private credential are required.");
  await assertShareReach(state.tomb, { kind: "vault" }, "write");
  if (unlocked().tomb !== state.tomb)
    throw new Error("The vault changed. Try again.");
  const item = createItem("secret", title.trim());
  if (item.kind !== "secret") throw new Error("Credential type unavailable.");
  item.value = value;
  item.notes = metadata.notes ?? "";
  if (metadata.url)
    item.fields = [
      { id: "url", name: "Website", value: metadata.url, hidden: false },
    ];
  await savePrivateItem(item);
  const saved = privateWriteSnapshot(state.tomb).items.find(
    (candidate) => candidate.id === item.id,
  );
  verifyCredentialWrite(saved, item);
  return {
    verified: true,
    id: item.id,
    ref: localReference(state.tomb, item.id, "value"),
  };
}
function verifyCredentialWrite(
  saved: VaultItem | undefined,
  expected: SecretItem,
) {
  if (
    saved?.kind !== "secret" ||
    saved.id !== expected.id ||
    saved.name !== expected.name ||
    saved.notes !== expected.notes ||
    saved.value !== expected.value ||
    JSON.stringify(saved.fields) !== JSON.stringify(expected.fields)
  )
    throw new Error(
      "Credential write is unverified. Do not retry automatically.",
    );
}

export async function comparePrivatePassword(
  id: string,
  candidate: string,
  apply = false,
  methodId?: string,
) {
  const state = unlocked();
  await assertShareReach(
    state.tomb,
    { kind: "item", id },
    apply ? "write" : "read",
  );
  if (unlocked().tomb !== state.tomb)
    throw new Error("The vault changed. Try again.");
  const item = unlocked().items.find(
    (entry) => entry.id === id && entry.deletedAt === null,
  );
  if (item?.kind !== "account")
    throw new Error("Choose an active account item.");
  if (!candidate.trim()) throw new Error("Enter a private password.");
  const method = selectedPassword(item, methodId);
  const matches = privatePasswordValue(method) === candidate;
  if (!apply || matches) return { matches, applied: false, id };
  const now = new Date().toISOString();
  const expected = withPrivatePassword(item, method, candidate, now);
  await savePrivateItem(expected);
  const saved = privateWriteSnapshot(state.tomb).items.find(
    (entry) => entry.id === id,
  );
  if (
    saved?.kind !== "account" ||
    !matchesWrittenAccount(saved, expected, item)
  )
    throw new Error(
      "Password write is unverified. Do not retry automatically.",
    );
  return { matches: true, applied: true, verified: true, id };
}

function privateWriteSnapshot(tomb: string) {
  const current = unlocked();
  if (current.tomb !== tomb)
    throw new Error(
      "The credential write is unverified because the vault changed. Do not retry automatically.",
    );
  return current;
}

async function savePrivateItem(item: VaultItem): Promise<void> {
  try {
    await vaultStore.saveItem(item);
  } catch {
    throw new Error(
      "The credential write is unverified. Do not retry automatically (details suppressed).",
    );
  }
}

/** Human-only resolver: never register this operation as an agent tool. */
export async function resolveLocalReference(
  reference: string,
): Promise<string> {
  const state = unlocked();
  const match = /^os:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(reference);
  if (!match)
    throw new Error(
      "Choose an os:// reference from this vault. Remote op:// resolution uses the native CLI.",
    );
  const tomb = decodeURIComponent(match[1] ?? "");
  const id = decodeURIComponent(match[2] ?? "");
  const field = decodeURIComponent(match[3] ?? "");
  if (tomb !== state.tomb)
    throw new Error("The reference belongs to a different vault.");
  await assertShareReach(tomb, { kind: "item", id }, "read");
  if (unlocked().tomb !== tomb)
    throw new Error("The vault changed. Try again.");
  const item = unlocked().items.find(
    (entry) => entry.id === id && entry.deletedAt === null,
  );
  if (!item) throw new Error("The referenced item was not found.");
  return secretFieldValue(item, field);
}
function secretFieldValue(item: VaultItem, field: string): string {
  if (item.kind === "account") {
    const value = accountSecretField(item, field);
    if (value !== undefined) return value;
  }
  if (field === "value" && item.kind === "secret") return item.value;
  const definition = definitionFor(item);
  const declared = definition
    ? definitionFields(definition).find(
        (entry) => entry.id === field && isConcealedFieldType(entry.type),
      )
    : undefined;
  if (declared) {
    const value = readItemField(item, declared);
    if (isString(value)) return value;
  }
  const custom = item.fields.find(
    (entry) => entry.id === field && entry.hidden,
  );
  if (custom) return custom.value;
  throw new Error("The referenced secret field was not found.");
}

export async function resolveLocalEnvTemplate(content: string) {
  unlocked();
  return resolveEnv(content, (references) =>
    Promise.all(references.map(resolveLocalReference)),
  );
}
