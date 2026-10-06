import { endpointAddress } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type RetiredCredentialCommand,
  parseRetiredCredentials,
} from "./parse-retired.js";
import {
  type SecurityCommand,
  parseCanaryServe,
  parseSecurity,
} from "./parse-security.js";

export const GlobalFlagsSchema = z.object({
  json: z.boolean().default(false),
  issuer: z.string().url().optional(),
  api: z.string().url().optional(),
  clientId: z.string().optional(),
});

export type GlobalFlags = z.infer<typeof GlobalFlagsSchema>;

export type ParsedCommand =
  | SecurityCommand
  | RetiredCredentialCommand
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

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  args.splice(idx, 2);
  return value;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const args = [...argv];
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

  const cmd = args.shift() ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { name: "help" };
  }

  if (cmd === "login") {
    const device = takeFlag(args, "--device");
    const loopback = takeFlag(args, "--loopback");
    const noBrowser = takeFlag(args, "--no-browser");
    const anonymous =
      takeFlag(args, "--anonymous") || takeFlag(args, "--guest");
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

  return parseLocalCommands(cmd, args, flags);
}

/** `login` is the pre-ADR 0172 name of `account`; it is still accepted as input. */
const ITEM_KINDS = new Set(["account", "login", "secret", "note", "card"]);

function leftover(args: readonly string[], verb: string): void {
  const extra = args[0];
  if (extra !== undefined) {
    throw new Error(`vault ${verb} does not take ${extra}`);
  }
}

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

function parseVaultSync(args: string[], flags: GlobalFlags): ParsedCommand {
  const code = takeOption(args, "--pair");
  leftover(args, "sync");
  return code === undefined
    ? { name: "vault-sync", flags }
    : { name: "vault-sync", code, flags };
}

function parseVaultList(args: string[], flags: GlobalFlags): ParsedCommand {
  leftover(args, "list");
  return { name: "vault-list", flags };
}

function parseVault(args: string[], flags: GlobalFlags): ParsedCommand {
  const verb = args.shift() ?? "";
  switch (verb) {
    case "retired-credentials":
      return parseRetiredCredentials(args, flags);
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

export { helpText } from "./help.js";

function parseLocalCommands(
  cmd: string,
  args: string[],
  flags: GlobalFlags,
): ParsedCommand {
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

  if (cmd === "security") return parseSecurity(args, flags);
  if (cmd === "canary") return parseCanaryServe(args, flags);
  if (cmd === "vault") return parseVault(args, flags);

  throw new Error(`Unknown command: ${cmd}`);
}
