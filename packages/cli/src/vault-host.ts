/** Node vault host with package-owned native physical custody for owner security operations. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { nativeCompanionPath } from "./native-companion.js";
import { createNativeVaultPorts } from "./native-vault-ports.js";
export async function createCliVaultHost(
  stateDir: string,
  executable?: string,
) {
  await mkdir(join(stateDir, "origin-files"), { recursive: true, mode: 0o700 });
  const base = createNodeHost({ stateDir });
  await base.atRestKeys?.load();
  return {
    ...base,
    ...createNativeVaultPorts(stateDir, executable),
  };
}

/** Development-only source checkouts may run ordinary vault commands before building the release companion. */
export async function createAvailableCliVaultHost(stateDir: string) {
  try {
    return await createCliVaultHost(stateDir, await nativeCompanionPath());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return createNodeHost({ stateDir });
    throw error;
  }
}
