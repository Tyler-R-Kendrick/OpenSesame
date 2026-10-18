import type { LocalCanaryCommand } from "@opensesame/vault-core/local-vault-security.js";
import { z } from "zod";
import { leftover, takeOption } from "./parse-options.js";
import type { GlobalFlags } from "./parse.js";
export type CanaryCliCommand = {
  name: "vault-canary";
  command: LocalCanaryCommand;
  primary: "password" | "pin";
  factor?: "totp" | "email" | "sms" | "recovery";
  out?: string;
  flags: GlobalFlags;
};
function receiver(args: string[]) {
  return {
    endpoint: z.string().url().parse(takeOption(args, "--receiver")),
    serviceId: z
      .string()
      .min(1)
      .max(200)
      .parse(takeOption(args, "--service-id")),
    browserOrigin: z.string().url().parse(takeOption(args, "--origin")),
    bindPort: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(takeOption(args, "--port")),
  };
}
function enrollment(args: string[]): LocalCanaryCommand["action"] {
  const label = z.string().min(1).max(200).parse(takeOption(args, "--label"));
  const artifactKind = z
    .enum(["mcp-config", "connection-reference"])
    .parse(takeOption(args, "--artifact-kind"));
  const retentionDays = z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .parse(takeOption(args, "--retention-days") ?? "90");
  const consent = args.indexOf("--owner-consent");
  if (consent < 0)
    throw new Error("Canary enrollment requires --owner-consent.");
  args.splice(consent, 1);
  return {
    kind: "enroll",
    label,
    artifactKind,
    retentionDays,
    ownerConsent: true,
  };
}
function action(kind: string, args: string[]): LocalCanaryCommand["action"] {
  if (kind === "enroll") return enrollment(args);
  if (kind === "pairing" || kind === "inspect") return { kind };
  if (kind !== "remove" && kind !== "export")
    throw new Error("Unknown canary action.");
  const id = args.shift();
  if (!id) throw new Error("Canary action requires its id.");
  return { kind, id };
}
export function parseVaultCanary(
  args: string[],
  flags: GlobalFlags,
): CanaryCliCommand {
  const kind = args.shift() ?? "inspect";
  const primary = z
    .enum(["password", "pin"])
    .parse(takeOption(args, "--primary") ?? "password");
  const factor = z
    .enum(["totp", "email", "sms", "recovery"])
    .optional()
    .parse(takeOption(args, "--factor"));
  const out = takeOption(args, "--out");
  const command = { receiver: receiver(args), action: action(kind, args) };
  leftover(args, "canary");
  const parsed: CanaryCliCommand = {
    name: "vault-canary",
    command,
    primary,
    flags,
  };
  if (factor !== undefined) parsed.factor = factor;
  if (out !== undefined) parsed.out = out;
  return parsed;
}
