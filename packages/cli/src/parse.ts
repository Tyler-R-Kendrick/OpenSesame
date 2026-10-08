import { z } from "zod";
import { type ParityCommand, parseParity } from "./parity-parse.js";
import { leftover, takeOption } from "./parse-options.js";
import { parseVaultSync } from "./parse-vault-sync.js";

export const GlobalFlagsSchema = z.object({
  json: z.boolean().default(false),
  issuer: z.string().url().optional(),
  api: z.string().url().optional(),
  clientId: z.string().optional(),
});

export type GlobalFlags = z.infer<typeof GlobalFlagsSchema>;

export type ParsedCommand =
  | ParityCommand
  | { name: "help" }
  | { name: "vault-verify"; file: string; flags: GlobalFlags }
  | { name: "vault-ls"; file: string; flags: GlobalFlags }
  | { name: "vault-list"; flags: GlobalFlags }
  | {
      name: "vault-new";
      kind: string;
      itemName: string;
      username?: string;
      flags: GlobalFlags;
    }
  | { name: "vault-import"; file: string; flags: GlobalFlags }
  | { name: "vault-export"; out?: string; flags: GlobalFlags }
  | {
      name: "vault-set";
      query: string;
      itemName?: string;
      username?: string;
      secret: boolean;
      flags: GlobalFlags;
    }
  | {
      name: "vault-copy";
      query: string;
      field: "secret" | "rest" | "username";
      flags: GlobalFlags;
    }
  | { name: "vault-share"; query: string; flags: GlobalFlags }
  | { name: "vault-sync"; code?: string; flags: GlobalFlags };

function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const args = [...argv];
  const separator = args.indexOf("--");
  const trailing = separator < 0 ? [] : args.splice(separator);
  const json = takeFlag(args, "--json");
  const issuer = takeOption(args, "--issuer");
  const api = takeOption(args, "--api");
  const clientId = takeOption(args, "--client-id");
  const flags = GlobalFlagsSchema.parse({
    json,
    ...(issuer !== undefined ? { issuer } : undefined),
    ...(api !== undefined ? { api } : undefined),
    ...(clientId !== undefined ? { clientId } : undefined),
  });

  args.push(...trailing);
  const cmd = args.shift() ?? "help";
  const parity = parseParity(cmd, args, flags);
  if (parity) return parity;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { name: "help" };
  }

  if (cmd === "vault") return parseVault(args, flags);

  throw new Error(`Unknown command: ${cmd}`);
}

/** `login` is the pre-ADR 0172 name of `account`; it is still accepted as input. */
const ITEM_KINDS = new Set(["account", "login", "secret", "note", "card"]);

function parseVaultFile(
  verb: "verify" | "ls",
  args: string[],
  flags: GlobalFlags,
): ParsedCommand {
  const file = args.shift();
  if (!file) throw new Error(`vault ${verb} requires a vault file`);
  leftover(args, verb);
  const name = verb === "verify" ? "vault-verify" : "vault-ls";
  return { name, file, flags };
}

function parseVaultImport(args: string[], flags: GlobalFlags): ParsedCommand {
  const file = args.shift();
  if (!file) throw new Error("vault import requires a file");
  leftover(args, "import");
  return { name: "vault-import", file, flags };
}

function parseVaultExport(args: string[], flags: GlobalFlags): ParsedCommand {
  const out = takeOption(args, "--out");
  leftover(args, "export");
  if (out === undefined) return { name: "vault-export", flags };
  return { name: "vault-export", out, flags };
}

function parseVaultShare(args: string[], flags: GlobalFlags): ParsedCommand {
  const query = args.shift();
  if (!query) throw new Error("vault share requires an item name or id");
  leftover(args, "share");
  return { name: "vault-share", query, flags };
}

function parseVaultList(args: string[], flags: GlobalFlags): ParsedCommand {
  leftover(args, "list");
  return { name: "vault-list", flags };
}

function parseVault(args: string[], flags: GlobalFlags): ParsedCommand {
  const verb = args.shift() ?? "";
  switch (verb) {
    case "verify":
      return parseVaultFile("verify", args, flags);
    case "ls":
      return parseVaultFile("ls", args, flags);
    case "list":
      return parseVaultList(args, flags);
    case "new":
      return parseVaultNew(args, flags);
    case "import":
      return parseVaultImport(args, flags);
    case "export":
      return parseVaultExport(args, flags);
    case "set":
      return parseVaultSet("set", args, flags);
    case "edit":
      return parseVaultSet("edit", args, flags);
    case "copy":
      return parseVaultCopy(args, flags);
    case "share":
      return parseVaultShare(args, flags);
    case "sync":
      return parseVaultSync(args, flags);
    default:
      throw new Error(`Unknown command: vault ${verb}`);
  }
}

function parseVaultNew(args: string[], flags: GlobalFlags): ParsedCommand {
  const word = args.shift();
  const itemName = takeOption(args, "--name");
  const username = takeOption(args, "--username");
  if (!word || !itemName) {
    throw new Error("vault new requires <kind> and --name");
  }
  if (!ITEM_KINDS.has(word)) {
    throw new Error("vault new kind must be account, secret, note, or card");
  }
  const kind = word === "login" ? "account" : word;
  leftover(args, "new");
  if (username === undefined) {
    return { name: "vault-new", kind, itemName, flags };
  }
  return { name: "vault-new", kind, itemName, username, flags };
}

function parseVaultSet(
  verb: string,
  args: string[],
  flags: GlobalFlags,
): ParsedCommand {
  const query = args.shift();
  const itemName = takeOption(args, "--name");
  const username = takeOption(args, "--username");
  const secret = takeFlag(args, "--secret");
  if (!query) throw new Error(`vault ${verb} requires an item name or id`);
  if (itemName === undefined && username === undefined && !secret) {
    throw new Error(`vault ${verb} needs --name, --username, or --secret`);
  }
  leftover(args, verb);
  if (itemName !== undefined && username !== undefined) {
    return { name: "vault-set", query, itemName, username, secret, flags };
  }
  if (itemName !== undefined) {
    return { name: "vault-set", query, itemName, secret, flags };
  }
  if (username !== undefined) {
    return { name: "vault-set", query, username, secret, flags };
  }
  return { name: "vault-set", query, secret, flags };
}

function parseVaultCopy(args: string[], flags: GlobalFlags): ParsedCommand {
  const query = args.shift();
  const fieldWord = takeOption(args, "--field") ?? "secret";
  if (!query) throw new Error("vault copy requires an item name or id");
  if (
    fieldWord !== "secret" &&
    fieldWord !== "rest" &&
    fieldWord !== "username"
  ) {
    throw new Error("vault copy --field must be secret, rest or username");
  }
  leftover(args, "copy");
  return { name: "vault-copy", query, field: fieldWord, flags };
}

export const SessionFileSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number().optional(),
  issuer: z.string().url(),
  clientId: z.string(),
  /** Guest (provisional) session: claimable later, principal id preserved. */
  anonymous: z.boolean().optional(),
  principalId: z.string().optional(),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export function helpText(): string {
  return `opensesame-id — local vault CLI (alias: opensesame-identity)

Commands:
  find <query...> [--vault <vault>] [--account <account>]
  inventory | audit           Metadata and organization checks, never values
  create api-credential --title <title> --vault <vault> --stdin|--clipboard
  password <item> --vault <vault> --stdin|--clipboard [--apply]
  read <op://reference>        Explicit plaintext stdout
  run --env NAME=op://reference -- <command...>
  env write <file> <NAME=op://reference...>
  env resolve <file> --output <file>|--in-place
  env run <file> -- <command...>
  service-account setup|connect|status|recover|forget
  request <https-url> --secret <op://reference> [--lease <id>]
  lease approve <https-url> --secret <ref> --desktop [--expires-in 10m] [--uses 1]
  lease list|status <id>|revoke <id>
  doctor                      Inspect provider setup without authentication
  vault verify <file>          Open a vault export or offline backup
                               (master password from the terminal only)
  vault ls <file>              List that file: path and kind, never values
  vault new <kind> --name <n>  Create an account, secret, note, or card
  vault list                   List the local vault: id, kind, and name
  vault import <file>          Merge a sealed export into the local vault
  vault export [--out <file>]  Write a sealed export of the local vault
  vault set|edit <item>        Change --name, --username, or --secret
  vault copy <item> [--field secret|username]
                               Copy a field to the clipboard, never print it
  vault share <item>           Share a secret once; prints the link and code
  vault sync [--pair <code>]   Sync with a tailnet drive (ADR 0144); with no
                               vault here, set it up from the drive first
  mcp host|client              Serve MCP tools (stdio; OPENSESAME_MCP_TRANSPORT=http for HTTP)

Global:
  --json          Machine-readable output (secrets redacted)
`;
}
