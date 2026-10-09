import { endpointAddress } from "@opensesame/os-domain";
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
  | {
      name: "login";
      mode: "device" | "loopback" | "anonymous" | "auto";
      qrPreference: "auto" | "on" | "off";
      flags: GlobalFlags;
    }
  | { name: "auth-status"; flags: GlobalFlags }
  | { name: "logout"; flags: GlobalFlags }
  | { name: "whoami"; flags: GlobalFlags }
  | {
      name: "project-create";
      temporary: boolean;
      projectName: string;
      flags: GlobalFlags;
    }
  | {
      name: "claim-poll";
      claimId: string;
      claimToken: string;
      flags: GlobalFlags;
    }
  | {
      name: "agent-init";
      anonymous: boolean;
      displayName: string;
      flags: GlobalFlags;
    }
  | { name: "host-health"; hostUrl: string; flags: GlobalFlags }
  | { name: "host-discover"; hostUrl: string; flags: GlobalFlags }
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

  if (cmd === "login") return parseLogin(args, flags);

  if (cmd === "auth" && args[0] === "status") {
    args.shift();
    return { name: "auth-status", flags };
  }

  if (cmd === "logout") return { name: "logout", flags };
  if (cmd === "whoami") return { name: "whoami", flags };

  if (cmd === "project" && args[0] === "create") {
    args.shift();
    const temporary = takeFlag(args, "--temporary");
    const nameOpt = takeOption(args, "--name") ?? args.shift() ?? "tmp-project";
    return {
      name: "project-create",
      temporary,
      projectName: nameOpt,
      flags,
    };
  }

  if (cmd === "claim" && args[0] === "poll") {
    args.shift();
    const claimId = takeOption(args, "--id") ?? args.shift();
    if (!claimId) throw new Error("claim poll requires claim id");
    // Claim state is only readable with the claim bearer (osc_clm_…).
    const claimToken =
      takeOption(args, "--token") ??
      process.env.OPENSESAME_CLAIM_TOKEN ??
      args.shift();
    if (!claimToken) {
      throw new Error(
        "claim poll requires the claim token (--token osc_clm_… or OPENSESAME_CLAIM_TOKEN)",
      );
    }
    return { name: "claim-poll", claimId, claimToken, flags };
  }

  if (cmd === "agent" && args[0] === "init") {
    args.shift();
    const anonymous = takeFlag(args, "--anonymous");
    const displayName =
      takeOption(args, "--name") ?? args.shift() ?? "anonymous-agent";
    return { name: "agent-init", anonymous, displayName, flags };
  }

  if (cmd === "host" && args[0] === "health") {
    args.shift();
    const hostUrl =
      takeOption(args, "--host") ?? endpointAddress("host", process.env);
    return { name: "host-health", hostUrl, flags };
  }

  if (cmd === "host" && args[0] === "discover") {
    args.shift();
    const hostUrl =
      takeOption(args, "--host") ?? endpointAddress("host", process.env);
    return { name: "host-discover", hostUrl, flags };
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
  return `opensesame-id — OpenSesame identity CLI (alias: opensesame-identity)

Commands:
  find <query...> [--vault <vault>] [--account <account>]
  inventory | audit           Metadata and organization checks, never values
  create api-credential --title <title> --vault <vault> --stdin|--clipboard
  password <item> --vault <vault> --stdin|--clipboard [--apply]
  read <op://reference> [--reveal] [--desktop]
                               Human-only plaintext stdout (TTY, no agent context)
  run --env NAME=op://reference -- <command...>
  env write <file> <NAME=op://reference...>
  env resolve <file> --output <file>|--in-place
  env run <file> -- <command...>
  service-account setup|connect|status|recover|forget
  request <https-url> --secret <op://reference> [--lease <id>]
  lease approve <https-url> --secret <ref> --desktop [--expires-in 10m] [--uses 1]
  lease list|status <id>|revoke <id>
  doctor                      Inspect provider setup without authentication
  login [--device|--loopback|--no-browser|--anonymous] [--qr|--no-qr]
                  --anonymous (alias --guest): start as a provisional guest;
                  link an identity later to keep the same principal id
  auth status
  logout
  whoami
  project create --temporary [--name <name>]
  claim poll <claimId> --token <osc_clm_…>   (or OPENSESAME_CLAIM_TOKEN)
  agent init --anonymous [--name <name>]
  host health [--host <url>]   Host API (:8787) via api-client
  host discover [--host <url>] Host PRM / readiness discovery
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
  mcp host|client              Serve the host- or client-facing MCP tools
                               (stdio; OPENSESAME_MCP_TRANSPORT=http for HTTP)

Global:
  --json          Machine-readable output (secrets redacted)
  --issuer <url>  OIDC issuer (default OPENSESAME_ISSUER or http://127.0.0.1:8788)
  --api <url>     Identity control plane API base
  --client-id <id>
  --qr / --no-qr  Device login: print a terminal QR (default: on for TTY)
`;
}

function parseLogin(args: string[], flags: GlobalFlags): ParsedCommand {
  const device = takeFlag(args, "--device");
  const loopback = takeFlag(args, "--loopback");
  const noBrowser = takeFlag(args, "--no-browser");
  const anonymous = takeFlag(args, "--anonymous") || takeFlag(args, "--guest");
  const qr = takeFlag(args, "--qr");
  const noQr = takeFlag(args, "--no-qr");
  let mode: "device" | "loopback" | "anonymous" | "auto" = "auto";
  if (anonymous) mode = "anonymous";
  else if (device || noBrowser) mode = "device";
  else if (loopback) mode = "loopback";
  let qrPreference: "auto" | "on" | "off" = "auto";
  if (noQr) qrPreference = "off";
  else if (qr) qrPreference = "on";
  return { name: "login", mode, qrPreference, flags };
}
