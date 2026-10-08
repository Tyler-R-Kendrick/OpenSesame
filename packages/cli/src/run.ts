import { overlapCast } from "@opensesame/os-domain";
import { errorLine } from "./output.js";
import { type ParityDependencies, runParity } from "./parity.js";
import { type ParsedCommand, helpText, parseArgs } from "./parse.js";
import { type VaultDependencies, runVaultCommand } from "./vault-commands.js";
import { type VaultItemDependencies, runVaultItems } from "./vault-items.js";
import { type VaultSyncDependencies, runVaultSync } from "./vault-sync.js";

interface RunDependencies
  extends VaultDependencies,
    VaultItemDependencies,
    VaultSyncDependencies,
    ParityDependencies {}

export async function runCli(
  argv: string[],
  deps?: RunDependencies,
): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseArgs(argv);
  } catch (err) {
    process.stderr.write(errorLine(overlapCast(err)));
    return 1;
  }

  if (command.name === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  try {
    return await dispatch(command, deps);
  } catch (err) {
    process.stderr.write(errorLine(overlapCast(err)));
    return 1;
  }
}

async function dispatch(
  command: Exclude<ParsedCommand, { name: "help" }>,
  deps: RunDependencies | undefined,
): Promise<number> {
  switch (command.name) {
    case "parity":
      return runParity(command, deps);
    case "vault-verify":
    case "vault-ls":
      return runVaultCommand(command, deps);
    case "vault-list":
    case "vault-new":
    case "vault-import":
    case "vault-export":
    case "vault-set":
    case "vault-copy":
    case "vault-share":
      return runVaultItems(command, deps);
    case "vault-sync":
      return runVaultSync(command, deps);
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return 1;
    }
  }
}

export { parseArgs, helpText };
