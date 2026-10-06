import { leftover, takeOption } from "./parse-options.js";
import type { GlobalFlags, ParsedCommand } from "./parse.js";

export function parseVaultSync(
  args: string[],
  flags: GlobalFlags,
): ParsedCommand {
  const code = takeOption(args, "--pair");
  leftover(args, "sync");
  return code === undefined
    ? { name: "vault-sync", flags }
    : { name: "vault-sync", code, flags };
}
