import { z } from "zod";

export const GlobalFlagsSchema = z.object({
  json: z.boolean().default(false),
  issuer: z.string().url().optional(),
  api: z.string().url().optional(),
  clientId: z.string().optional(),
});

export type GlobalFlags = z.infer<typeof GlobalFlagsSchema>;

export type ParsedCommand =
  | { name: "help" }
  | {
      name: "login";
      mode: "device" | "loopback" | "auto";
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
  | { name: "host-discover"; hostUrl: string; flags: GlobalFlags };

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
    ...(issuer !== undefined ? { issuer } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  });

  const cmd = args.shift() ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { name: "help" };
  }

  if (cmd === "login") {
    const device = takeFlag(args, "--device");
    const loopback = takeFlag(args, "--loopback");
    const noBrowser = takeFlag(args, "--no-browser");
    const qr = takeFlag(args, "--qr");
    const noQr = takeFlag(args, "--no-qr");
    let mode: "device" | "loopback" | "auto" = "auto";
    if (device || noBrowser) mode = "device";
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

  if (cmd === "host" && args[0] === "health") {
    args.shift();
    const hostUrl =
      takeOption(args, "--host") ??
      process.env.OPENSESAME_HOST_API ??
      "http://127.0.0.1:8787";
    return { name: "host-health", hostUrl, flags };
  }

  if (cmd === "host" && args[0] === "discover") {
    args.shift();
    const hostUrl =
      takeOption(args, "--host") ??
      process.env.OPENSESAME_HOST_API ??
      "http://127.0.0.1:8787";
    return { name: "host-discover", hostUrl, flags };
  }

  throw new Error(`Unknown command: ${cmd}`);
}

export const SessionFileSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number().optional(),
  issuer: z.string().url(),
  clientId: z.string(),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export function helpText(): string {
  return `opensesame-id — OpenSesame identity CLI (alias: opensesame-identity)

Commands:
  login [--device|--loopback|--no-browser] [--qr|--no-qr]
  auth status
  logout
  whoami
  project create --temporary [--name <name>]
  claim poll <claimId> --token <osc_clm_…>   (or OPENSESAME_CLAIM_TOKEN)
  agent init --anonymous [--name <name>]
  host health [--host <url>]   Host API (:8787) via api-client
  host discover [--host <url>] Host PRM / readiness discovery

Global:
  --json          Machine-readable output (secrets redacted)
  --issuer <url>  OIDC issuer (default OPENSESAME_ISSUER or http://127.0.0.1:8788)
  --api <url>     Identity control plane API base
  --client-id <id>
  --qr / --no-qr  Device login: print a terminal QR (default: on for TTY)
`;
}
