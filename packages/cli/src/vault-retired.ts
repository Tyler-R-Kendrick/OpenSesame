/** Human terminal adapter. Identity login, agent flags and DATA never provide owner authority. */
import { configureHost } from "@opensesame/app-core/host.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import type {
  LocalRetiredCommand,
  LocalVaultSecurityPort,
  LocalVaultStarted,
} from "@opensesame/vault-core/local-vault-security.js";
import { emit } from "./output.js";
import type { RetiredCliCommand } from "./parse-vault-retired.js";
import { readPasswordFromTty } from "./tty-password.js";
import { createCliVaultHost } from "./vault-host.js";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";

export interface RetiredCliDependencies {
  stateDir?: string;
  readPassword?: (prompt: string) => Promise<string>;
  /** Local human shell only; never supplied by an identity token or MCP transport. */
  retiredSecurity?: Pick<
    LocalVaultSecurityPort,
    "beginRetired" | "isRetiredResultCurrent"
  >;
}
export async function openCliSecurity(stateDir: string) {
  await useVaultKv(stateDir);
  configureHost(await createCliVaultHost(stateDir));
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  vaultStore.lock();
  vaultStore.rehydrate();
  return vaultStore;
}
async function request(
  command: RetiredCliCommand,
  read: (prompt: string) => Promise<string>,
): Promise<LocalRetiredCommand> {
  if (command.action === "inspect") return { kind: "inspect" };
  if (command.action === "enroll") {
    const password = await read("Retired password: ");
    if (password !== (await read("Retired password again: ")))
      throw new Error("The retired passwords did not match.");
    if (!command.response) throw new Error("Select a retired response.");
    return {
      kind: "change",
      change: {
        type: "enroll",
        password,
        response: command.response,
        ...(command.retentionMs === undefined
          ? undefined
          : { retentionMs: command.retentionMs }),
      },
    };
  }
  if (command.action === "remove") {
    if (!command.id) throw new Error("Select a retired credential.");
    return { kind: "change", change: { type: "remove", id: command.id } };
  }
  return { kind: "change", change: { type: command.action } };
}
export async function completeCliOwnerOperation<T extends object>(
  started: LocalVaultStarted<T>,
  command: Pick<RetiredCliCommand, "factor">,
  read: (prompt: string) => Promise<string>,
) {
  if (started.kind === "complete") return started.result;
  try {
    const route = command.factor ?? started.routes[0];
    if (!route || !started.routes.includes(route))
      throw new Error("A configured factor route is required.");
    if (route === "email" || route === "sms") await started.requestCode(route);
    const code = await read(`${route} code: `);
    return await started.complete({
      kind: route === "email" || route === "sms" ? "remote" : route,
      code,
    });
  } finally {
    await started.cancel();
  }
}
export async function runVaultRetired(
  command: RetiredCliCommand,
  deps: RetiredCliDependencies = {},
): Promise<number> {
  const read = deps.readPassword ?? readPasswordFromTty;
  const security =
    deps.retiredSecurity ??
    (await openCliSecurity(deps.stateDir ?? defaultStateDir()));
  try {
    const secret = await read(
      command.primary === "pin" ? "Current PIN: " : "Current master password: ",
    );
    const started = await security.beginRetired(
      { kind: command.primary, secret },
      await request(command, read),
    );
    const result = await completeCliOwnerOperation(started, command, read);
    if (!security.isRetiredResultCurrent(result))
      throw new Error("The owner operation ended. Authenticate again.");
    emit(command.flags, JSON.stringify(result, null, 2), {
      traps: result.traps.map((trap) => ({ ...trap })),
      events: result.events.map((event) => ({ ...event })),
      stale: result.stale,
    });
    return 0;
  } finally {
    if (!deps.retiredSecurity) await releaseVaultKv();
  }
}
