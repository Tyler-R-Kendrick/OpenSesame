import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, vi } from "vitest";
import { processFixture } from "./fixtures/password-agent/process.js";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault } from "./vault-session.js";

export const OWNER_PASSWORD = "runtime owner proof password 739";
export let fixture: Awaited<ReturnType<typeof processFixture>>;
export let owner: VaultStore;

/** Execute the public entrypoint; provider processes and private files remain real. */
export async function execute(args: string[], input = "runtime-private-input") {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const code = await runCli(args, { privateInput: async () => input });
    return {
      code,
      stdout: stdout.mock.calls.map(([value]) => String(value)).join(""),
      stderr: stderr.mock.calls.map(([value]) => String(value)).join(""),
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

export function installRuntimeFixture(): void {
  beforeEach(async () => {
    fixture = await processFixture();
    for (const name of [
      "PATH",
      "PARITY_DB",
      "PARITY_LOG",
      "OPENSESAME_STATE_DIR",
      "OP_SERVICE_ACCOUNT_TOKEN",
    ])
      vi.stubEnv(name, fixture.env[name]);
    owner = await openLocalVault(join(fixture.directory, "owner"));
    await owner.create(OWNER_PASSWORD);
  });
  afterEach(async () => {
    await releaseVaultKv();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(fixture.directory, { recursive: true, force: true });
  });
}
