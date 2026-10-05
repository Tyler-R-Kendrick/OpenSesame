import { isString } from "@opensesame/os-domain";
import {
  type VaultItem,
  accountTotp,
  definitionFor,
  readItemField,
} from "@opensesame/vault-core";
import { type AskPepper, readAccountPassword } from "../account-password.js";
import {
  type AppCommand,
  type CommandOutcome,
  commandPathAuthorized,
  isCommandSection,
} from "./types.js";

/** What a person hears when a command names a section the plan excludes. */
export const NOT_AVAILABLE_MESSAGE = "Not available on this installation";

export type CommandPorts = {
  navigate: (path: string) => void;
  copy: (value: string) => Promise<"copied" | "unavailable">;
  items: () => readonly VaultItem[];
  vaultLocked: () => boolean;
  /**
   * Ask for a pepper (ADR 0168 §4). Without it a peppered or Sphinx password
   * has nothing to copy; with it the question is asked once per command.
   */
  askPepper?: AskPepper;
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

/** What a copy reads: a value, or the reason there is none to copy. */
type Read = { value: string | null } | { refusal: CommandOutcome };

async function accountPassword(
  item: Extract<VaultItem, { kind: "account" }>,
  ports: CommandPorts,
): Promise<Read> {
  const reading = await readAccountPassword(item, ports.askPepper);
  switch (reading.status) {
    case "ok":
      return { value: reading.password };
    case "cancelled":
      return { refusal: { ok: false, message: "Cancelled." } };
    case "wrong":
      return {
        refusal: { ok: false, message: "That pepper did not open it." },
      };
    default:
      return { value: null };
  }
}

async function fieldValue(
  item: VaultItem,
  field: Extract<AppCommand, { action: "copy_field" }>["field"],
  ports: CommandPorts,
): Promise<Read> {
  if (field === "password") {
    if (item.kind === "account") return accountPassword(item, ports);
    return { value: concealedValue(item) };
  }
  return { value: plainFieldValue(item, field) };
}

function plainFieldValue(
  item: VaultItem,
  field: Extract<AppCommand, { action: "copy_field" }>["field"],
): string | null {
  if (field === "username") {
    return item.kind === "account" || item.kind === "passkey"
      ? item.username
      : null;
  }
  if (field === "otp") {
    return item.kind === "account" ? accountTotp(item) : null;
  }
  if (field === "url") {
    if (item.kind === "account") {
      const uri = item.uris[0]?.uri;
      return uri !== undefined && uri !== "" ? uri : null;
    }
    if (item.kind === "passkey") return item.rpId;
    return null;
  }
  return null;
}

/** One item command's subject, or the refusal that stands in for it. */
function subjectOf(
  ports: CommandPorts,
  query: string,
): { item: VaultItem } | { refusal: CommandOutcome } {
  if (ports.vaultLocked()) {
    return { refusal: { ok: false, message: "Unlock the vault first." } };
  }
  const item = matchItem(ports.items(), query);
  if (item === null) {
    return { refusal: { ok: false, message: `No item matches “${query}”.` } };
  }
  return { item };
}

async function openItem(
  command: Extract<AppCommand, { action: "open_item" }>,
  ports: CommandPorts,
): Promise<CommandOutcome> {
  const subject = subjectOf(ports, command.query);
  if ("refusal" in subject) return subject.refusal;
  ports.navigate(`/vault/${subject.item.id}`);
  return { ok: true, message: `Opened ${subject.item.name}` };
}

async function copyField(
  command: Extract<AppCommand, { action: "copy_field" }>,
  ports: CommandPorts,
): Promise<CommandOutcome> {
  const subject = subjectOf(ports, command.query);
  if ("refusal" in subject) return subject.refusal;
  const { item } = subject;
  const read = await fieldValue(item, command.field, ports);
  if ("refusal" in read) return read.refusal;
  const { value } = read;
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
  return { ok: true, message: `Copied ${command.field} for ${item.name}` };
}

/** A section command opens a route only when the plan registered one. */
function openSection(
  command: Extract<AppCommand, { action: "navigate" }>,
  ports: CommandPorts,
): CommandOutcome {
  // Refused, not imported: a section that is not registered has no route
  // to open, and nothing here reaches for the module that would have one.
  if (!isCommandSection(command.path)) {
    return { ok: false, message: NOT_AVAILABLE_MESSAGE };
  }
  // Listed is not authorized: the capability that registered the path must
  // still hold a current lease under a plan that approves it (§4.2).
  if (!commandPathAuthorized(command.path)) {
    return { ok: false, message: NOT_AVAILABLE_MESSAGE };
  }
  ports.navigate(command.path);
  return { ok: true, message: `Opened ${command.path}` };
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
        message: "Try: /vault · /? … · /open … · copy password for …",
      };
    case "navigate":
      return openSection(command, ports);
    case "open_path":
      ports.navigate(command.path);
      return { ok: true, message: `Opened ${command.label}` };
    case "search":
      // `f=all` is the list of everything on a phone too, where the bare
      // `/vault` is the section tree; the list narrows itself to `q`.
      ports.navigate(`/vault?f=all&q=${encodeURIComponent(command.query)}`);
      return { ok: true, message: `Searching for “${command.query}”` };
    case "open_item":
      return openItem(command, ports);
    case "copy_field":
      return copyField(command, ports);
  }
}
