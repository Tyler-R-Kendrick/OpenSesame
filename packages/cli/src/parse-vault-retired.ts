import { z } from "zod";
import { leftover, takeOption } from "./parse-options.js";
import type { GlobalFlags } from "./parse.js";
const actionSchema = z.enum([
  "inspect",
  "enroll",
  "remove",
  "clear-stale",
  "clear-events",
]);
const primarySchema = z.enum(["password", "pin"]);
const factorSchema = z.enum(["totp", "email", "sms", "recovery"]);
export type RetiredCliCommand = {
  name: "vault-retired";
  action: z.infer<typeof actionSchema>;
  id?: string;
  response?: "reject" | "synthetic_decoy";
  retentionMs?: number;
  primary: z.infer<typeof primarySchema>;
  factor?: z.infer<typeof factorSchema>;
  flags: GlobalFlags;
};
function enrollment(
  args: string[],
): Pick<RetiredCliCommand, "response" | "retentionMs"> {
  const response = takeOption(args, "--response");
  if (response !== "reject" && response !== "synthetic_decoy")
    throw new Error(
      "Enrollment requires --response reject or synthetic_decoy.",
    );
  const days = takeOption(args, "--retention-days");
  if (days === undefined) return { response };
  const value = Number(days);
  if (!Number.isInteger(value) || value < 1 || value > 90)
    throw new Error("Retention must be 1–90 days.");
  return { response, retentionMs: value * 86_400_000 };
}
function removal(args: string[]) {
  const id = args.shift();
  if (!id) throw new Error("Removing a retired credential requires its id.");
  return { id };
}
export function parseVaultRetired(
  args: string[],
  flags: GlobalFlags,
): RetiredCliCommand {
  const action = actionSchema.parse(args.shift() ?? "inspect");
  const primary = primarySchema.parse(
    takeOption(args, "--primary") ?? "password",
  );
  const factor = factorSchema.optional().parse(takeOption(args, "--factor"));
  const options = action === "enroll" ? enrollment(args) : {};
  const target = action === "remove" ? removal(args) : {};
  leftover(args, "retired");
  const command: RetiredCliCommand = {
    name: "vault-retired",
    action,
    primary,
    flags,
    ...options,
    ...target,
  };
  if (factor !== undefined) command.factor = factor;
  return command;
}
