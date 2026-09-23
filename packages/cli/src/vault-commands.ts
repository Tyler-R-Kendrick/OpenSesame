/**
 * `opensesame-id vault verify <file>` and `vault ls <file>` (ADR 0133 §5):
 * open a sealed vault export or offline backup with its master password,
 * through the same read path the Pages PWA uses, and print what may be shown
 * — the tomb, whether the body is bound to it, its revision, and each item's
 * name, kind and path. No field value is ever printed. The password is read
 * from a terminal only.
 */
import { readFile } from "node:fs/promises";
import { configureHost } from "@opensesame/app-core/host.js";
import {
  VaultCorruptError,
  WrongPasswordError,
} from "@opensesame/app-core/lib/vault/crypto.js";
import {
  type OpenedVaultFile,
  openVaultFile,
} from "@opensesame/app-core/lib/vault/vault-file.js";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { emit } from "./output.js";
import type { ParsedCommand } from "./parse.js";
import { readPasswordFromTty } from "./tty-password.js";

type VaultCommand = Extract<
  ParsedCommand,
  { name: "vault-verify" | "vault-ls" }
>;

export interface VaultDependencies {
  /** Read the master password; the default reads the terminal only. */
  readPassword?: (prompt: string) => Promise<string>;
}

function describe(opened: OpenedVaultFile): string {
  const binding = opened.bound ? "bound to" : "legacy body, unbound from";
  const rev = opened.rev === null ? "" : `, revision ${opened.rev}`;
  const count = `${opened.items.length} item${opened.items.length === 1 ? "" : "s"}`;
  return `${opened.format}: ${binding} ${opened.tomb}${rev}, ${count}`;
}

function refusal(error: unknown): string {
  if (error instanceof WrongPasswordError) return "Wrong master password.";
  if (error instanceof VaultCorruptError)
    return `Not a readable vault file: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export async function runVaultCommand(
  command: VaultCommand,
  deps: VaultDependencies | undefined,
): Promise<number> {
  configureHost(createNodeHost());
  const text = await readFile(command.file, "utf8");
  const readPassword = deps?.readPassword ?? readPasswordFromTty;
  const password = await readPassword("Master password: ");
  let opened: OpenedVaultFile;
  try {
    opened = await openVaultFile(text, password);
  } catch (error) {
    process.stderr.write(`${refusal(error)}\n`);
    return 1;
  }
  const summary = {
    ok: true,
    format: opened.format,
    tomb: opened.tomb,
    bound: opened.bound,
    rev: opened.rev,
  };
  if (command.name === "vault-verify") {
    emit(command.flags, `OK — ${describe(opened)}`, {
      ...summary,
      items: opened.items.length,
    });
    return 0;
  }
  const lines = opened.items.map((item) => `${item.path}\t${item.kind}`);
  emit(command.flags, [describe(opened), ...lines].join("\n"), {
    ...summary,
    items: opened.items.map(({ id, name, kind, path }) => ({
      id,
      name,
      kind,
      path,
    })),
  });
  return 0;
}
