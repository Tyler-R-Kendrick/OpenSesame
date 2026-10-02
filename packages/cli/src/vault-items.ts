/**
 * The vault commands the Pages app already offers, on the local vault:
 * new, list, import, export, edit/set, copy, and share. A secret value is
 * read from the terminal and never printed. Copy puts it on the clipboard.
 * Share prints the one-time link, not the value.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { configureHost } from "@opensesame/app-core/host.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  createNodeHost,
  defaultStateDir,
} from "@opensesame/app-core/node/host.js";
import {
  shareText,
  username,
} from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type VaultItem,
  activeItems,
  createItem,
} from "@opensesame/vault-core";
import { emit } from "./output.js";
import type { ParsedCommand } from "./parse.js";
import { readPasswordFromTty } from "./tty-password.js";
import { writeClipboard } from "./vault-clipboard.js";
import { useVaultKv } from "./vault-kv.js";

type ItemCommand = Extract<
  ParsedCommand,
  {
    name:
      | "vault-list"
      | "vault-new"
      | "vault-import"
      | "vault-export"
      | "vault-set"
      | "vault-copy"
      | "vault-share";
  }
>;

export interface ShareResult {
  link: string;
  userCode: string;
  record: VaultItem;
}

export interface VaultItemDependencies {
  stateDir?: string;
  readPassword?: (prompt: string) => Promise<string>;
  readLine?: (prompt: string) => Promise<string>;
  writeClipboard?: (text: string) => Promise<void>;
  createShare?: (input: {
    name: string;
    payload: { kind: "text"; name: string; text: string };
  }) => Promise<ShareResult>;
}

const MASTER = "Master password: ";
const MASTER_AGAIN = "Master password again: ";
const SECRET = "Secret value: ";
const NEW_SECRET = "New value: ";
const EXPORT_PASSWORD = "Export password: ";

type Store = VaultStore;

async function openStore(deps: VaultItemDependencies): Promise<Store> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  await useVaultKv(stateDir);
  configureHost(createNodeHost({ stateDir }));
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  vaultStore.lock();
  vaultStore.rehydrate();
  return vaultStore;
}

async function ensureVault(
  store: Store,
  deps: VaultItemDependencies,
  createIfEmpty: boolean,
): Promise<void> {
  const readPassword = deps.readPassword ?? readPasswordFromTty;
  if (store.getSnapshot().status === "empty") {
    if (!createIfEmpty) {
      throw new Error("There is no vault yet. Create an item with vault new.");
    }
    const password = await readPassword(MASTER);
    const again = await readPassword(MASTER_AGAIN);
    if (password !== again)
      throw new Error("The master passwords did not match.");
    await store.create(password);
    return;
  }
  await store.unlock(await readPassword(MASTER));
}

function findItem(items: readonly VaultItem[], query: string): VaultItem {
  const live = activeItems([...items]);
  const byId = live.find((item) => item.id === query);
  if (byId) return byId;
  const named = live.filter(
    (item) => item.name.toLowerCase() === query.toLowerCase(),
  );
  if (named.length === 1 && named[0]) return named[0];
  if (named.length === 0) throw new Error(`No item named ${query}.`);
  throw new Error(`More than one item named ${query}. Pass the item id.`);
}

function blankItem(kind: string, name: string): VaultItem {
  if (
    kind === "login" ||
    kind === "secret" ||
    kind === "note" ||
    kind === "card"
  ) {
    return createItem(kind, name);
  }
  throw new Error("vault new kind must be login, secret, note, or card");
}

async function fillNewItem(
  item: VaultItem,
  usernameValue: string | undefined,
  deps: VaultItemDependencies,
): Promise<VaultItem> {
  const readPassword = deps.readPassword ?? readPasswordFromTty;
  const readLine = deps.readLine ?? readPassword;
  if (item.kind === "login") {
    const loginName = usernameValue ?? (await readLine("Username: "));
    const password = await readPassword(SECRET);
    return { ...item, username: loginName, password };
  }
  if (item.kind === "secret") {
    return { ...item, value: await readPassword(SECRET) };
  }
  if (item.kind === "note") {
    return { ...item, notes: await readPassword(SECRET) };
  }
  return item;
}

function withSecret(item: VaultItem, value: string): VaultItem {
  if (item.kind === "login") return { ...item, password: value };
  if (item.kind === "secret") return { ...item, value };
  if (item.kind === "note") return { ...item, notes: value };
  throw new Error(`A ${item.kind} has no secret to set.`);
}

async function defaultShare(input: {
  name: string;
  payload: { kind: "text"; name: string; text: string };
}): Promise<ShareResult> {
  const { createDrop } = await import("@opensesame/app-core/lib/vault/drop.js");
  return createDrop({ ...input, ttlMs: 3_600_000, keepCopy: true });
}

function listLines(items: readonly VaultItem[]): string {
  return activeItems([...items])
    .map((item) => `${item.id}\t${item.kind}\t${item.name}`)
    .join("\n");
}

async function runNew(
  command: Extract<ItemCommand, { name: "vault-new" }>,
  store: Store,
  deps: VaultItemDependencies,
): Promise<number> {
  const item = await fillNewItem(
    blankItem(command.kind, command.itemName),
    command.username,
    deps,
  );
  await store.saveItem(item);
  emit(command.flags, `Created ${item.kind} ${item.name}.`, {
    ok: true,
    id: item.id,
    kind: item.kind,
    name: item.name,
  });
  return 0;
}

async function runSet(
  command: Extract<ItemCommand, { name: "vault-set" }>,
  store: Store,
  deps: VaultItemDependencies,
): Promise<number> {
  let item = findItem(store.getSnapshot().items, command.query);
  if (command.itemName !== undefined)
    item = { ...item, name: command.itemName };
  if (command.username !== undefined) {
    if (item.kind !== "login" && item.kind !== "passkey") {
      throw new Error(`A ${item.kind} has no username.`);
    }
    item = { ...item, username: command.username };
  }
  if (command.secret) {
    const readPassword = deps.readPassword ?? readPasswordFromTty;
    item = withSecret(item, await readPassword(NEW_SECRET));
  }
  await store.saveItem(item);
  emit(command.flags, `Updated ${item.name}.`, {
    ok: true,
    id: item.id,
    kind: item.kind,
    name: item.name,
  });
  return 0;
}

async function runCopy(
  command: Extract<ItemCommand, { name: "vault-copy" }>,
  store: Store,
  deps: VaultItemDependencies,
): Promise<number> {
  const item = findItem(store.getSnapshot().items, command.query);
  const text = command.field === "username" ? username(item) : shareText(item);
  if (!text) throw new Error(`Nothing to copy from ${item.name}.`);
  await (deps.writeClipboard ?? writeClipboard)(text);
  emit(command.flags, "Copied.", {
    ok: true,
    id: item.id,
    field: command.field,
  });
  return 0;
}

async function runShare(
  command: Extract<ItemCommand, { name: "vault-share" }>,
  store: Store,
  deps: VaultItemDependencies,
): Promise<number> {
  const item = findItem(store.getSnapshot().items, command.query);
  if (item.kind !== "secret")
    throw new Error("Only a secret can be shared once.");
  const text = item.value;
  if (text === "") throw new Error(`Nothing to share from ${item.name}.`);
  const created = await (deps.createShare ?? defaultShare)({
    name: item.name || "Shared secret",
    payload: { kind: "text", name: item.name || "Shared secret", text },
  });
  await store.saveItem(created.record);
  emit(command.flags, `${created.link}\nCode: ${created.userCode}`, {
    ok: true,
    id: created.record.id,
    link: created.link,
    userCode: created.userCode,
  });
  return 0;
}

async function runImport(
  command: Extract<ItemCommand, { name: "vault-import" }>,
  store: Store,
  deps: VaultItemDependencies,
): Promise<number> {
  const readPassword = deps.readPassword ?? readPasswordFromTty;
  const fileText = await readFile(command.file, "utf8");
  const count = await store.importSealed(
    fileText,
    await readPassword(EXPORT_PASSWORD),
  );
  emit(command.flags, `Imported ${count} item${count === 1 ? "" : "s"}.`, {
    ok: true,
    imported: count,
  });
  return 0;
}

async function runExport(
  command: Extract<ItemCommand, { name: "vault-export" }>,
  store: Store,
): Promise<number> {
  const text = store.exportSealed();
  if (command.out) {
    await writeFile(command.out, text, { mode: 0o600 });
    await chmod(command.out, 0o600);
    emit(command.flags, `Wrote ${command.out}.`, {
      ok: true,
      out: command.out,
    });
    return 0;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

/** Run one local-vault command. The vault is locked again before returning. */
export async function runVaultItems(
  command: ItemCommand,
  deps: VaultItemDependencies | undefined,
): Promise<number> {
  const given = deps ?? {};
  const store = await openStore(given);
  try {
    await ensureVault(store, given, command.name === "vault-new");
    switch (command.name) {
      case "vault-new":
        return await runNew(command, store, given);
      case "vault-list":
        emit(command.flags, listLines(store.getSnapshot().items), {
          ok: true,
          items: activeItems([...store.getSnapshot().items]).map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
          })),
        });
        return 0;
      case "vault-import":
        return await runImport(command, store, given);
      case "vault-export":
        return await runExport(command, store);
      case "vault-set":
        return await runSet(command, store, given);
      case "vault-copy":
        return await runCopy(command, store, given);
      case "vault-share":
        return await runShare(command, store, given);
      default: {
        const _exhaustive: never = command;
        void _exhaustive;
        return 1;
      }
    }
  } finally {
    store.lock();
  }
}
