/** Human-only canary management uses fresh local owner/factor authentication. */
import { writeFile } from "node:fs/promises";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { overlapCast } from "@opensesame/os-domain";
import type { LocalVaultSecurityPort } from "@opensesame/vault-core/local-vault-security.js";
import { emit } from "./output.js";
import type { CanaryCliCommand } from "./parse-vault-canary.js";
import { readPasswordFromTty } from "./tty-password.js";
import { releaseVaultKv } from "./vault-kv.js";
import { completeCliOwnerOperation, openCliSecurity } from "./vault-retired.js";
export interface CanaryCliDependencies {
  stateDir?: string;
  readPassword?: (prompt: string) => Promise<string>;
  canarySecurity?: Pick<
    LocalVaultSecurityPort,
    "beginCanary" | "isCanaryResultCurrent"
  >;
}
export async function runVaultCanary(
  command: CanaryCliCommand,
  deps: CanaryCliDependencies = {},
): Promise<number> {
  const read = deps.readPassword ?? readPasswordFromTty;
  const security =
    deps.canarySecurity ??
    (await openCliSecurity(deps.stateDir ?? defaultStateDir()));
  try {
    const secret = await read(
      command.primary === "pin" ? "Current PIN: " : "Current master password: ",
    );
    const started = await security.beginCanary(
      { kind: command.primary, secret },
      command.command,
    );
    const result = await completeCliOwnerOperation(started, command, read);
    if (!security.isCanaryResultCurrent(result))
      throw new Error("The owner operation ended. Authenticate again.");
    // This result is the portable schema's public pairing/metadata or explicitly requested inert artifact.
    const data = overlapCast(JSON.parse(JSON.stringify(result)));
    if (command.out) {
      const value =
        result.kind === "pairing"
          ? result.pairing
          : result.kind === "configuration"
            ? result.configuration
            : result;
      await writeFile(command.out, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      emit(command.flags, `Wrote ${command.out}`, {
        ok: true,
        out: command.out,
      });
    } else emit(command.flags, JSON.stringify(result, null, 2), data);
    return 0;
  } finally {
    if (!deps.canarySecurity) await releaseVaultKv();
  }
}
