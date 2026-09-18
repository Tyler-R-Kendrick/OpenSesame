import { isString } from "@opensesame/os-domain";
import { definitionFor, readItemField } from "../vault/item-types.js";
import type { VaultItem } from "../vault/model.js";
import type { AppCommand, CommandOutcome } from "./types.js";

export type CommandPorts = {
  navigate: (path: string) => void;
  copy: (value: string) => Promise<"copied" | "unavailable">;
  items: () => readonly VaultItem[];
  vaultLocked: () => boolean;
};

function scoreName(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q === "") return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  return 0;
}

export function matchItem(
  items: readonly VaultItem[],
  query: string,
): VaultItem | null {
  let best: VaultItem | null = null;
  let bestScore = 0;
  for (const item of items) {
    if (item.deletedAt !== null) continue;
    const score = scoreName(item.name, query);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function concealedValue(item: VaultItem): string | null {
  if (item.kind === "login") return item.password;
  if (item.kind === "secret") return item.value;
  if (item.kind === "card") return item.number;
  if (item.kind === "certificate") return item.privateKeyPem;
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

function fieldValue(
  item: VaultItem,
  field: Extract<AppCommand, { action: "copy_field" }>["field"],
): string | null {
  if (field === "password") return concealedValue(item);
  if (field === "username") {
    return item.kind === "login" || item.kind === "passkey"
      ? item.username
      : null;
  }
  if (field === "otp") {
    return item.kind === "login" ? item.totp : null;
  }
  if (field === "url") {
    if (item.kind === "login") {
      const uri = item.uris[0]?.uri;
      return uri !== undefined && uri !== "" ? uri : null;
    }
    if (item.kind === "passkey") return item.rpId;
    return null;
  }
  return null;
}

export async function executeCommand(
  command: AppCommand,
  ports: CommandPorts,
): Promise<CommandOutcome> {
  switch (command.action) {
    case "refuse":
      return { ok: false, message: command.message };
    case "help":
      return {
        ok: true,
        message:
          "Try: go to vault · copy password for … · open … · search … · hold the mic to speak",
      };
    case "navigate":
      ports.navigate(command.path);
      return { ok: true, message: `Opened ${command.path}` };
    case "open_path":
      ports.navigate(command.path);
      return { ok: true, message: `Opened ${command.label}` };
    case "search":
      ports.navigate(`/vault?q=${encodeURIComponent(command.query)}`);
      return { ok: true, message: `Searching for “${command.query}”` };
    case "open_item": {
      if (ports.vaultLocked()) {
        return { ok: false, message: "Unlock the vault first." };
      }
      const item = matchItem(ports.items(), command.query);
      if (item === null) {
        return { ok: false, message: `No item matches “${command.query}”.` };
      }
      ports.navigate(`/vault/${item.id}`);
      return { ok: true, message: `Opened ${item.name}` };
    }
    case "copy_field": {
      if (ports.vaultLocked()) {
        return { ok: false, message: "Unlock the vault first." };
      }
      const item = matchItem(ports.items(), command.query);
      if (item === null) {
        return { ok: false, message: `No item matches “${command.query}”.` };
      }
      const value = fieldValue(item, command.field);
      if (value === null || value === "") {
        return {
          ok: false,
          message: `${item.name} has no ${command.field} to copy.`,
        };
      }
      const result = await ports.copy(value);
      if (result !== "copied") {
        return { ok: false, message: "Clipboard unavailable." };
      }
      return {
        ok: true,
        message: `Copied ${command.field} for ${item.name}`,
      };
    }
  }
}
