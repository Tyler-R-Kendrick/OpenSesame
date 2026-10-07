/** The CLI resolves the same policy documents without claiming a browser realm. */
import { join } from "node:path";
import type { CapabilityArtifacts } from "@opensesame/app-core/host.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { ensureInstallationId } from "@opensesame/app-core/lib/capabilities/installation.js";
import {
  CAPABILITY_BOOT_KEYS,
  vaultSelectionKey,
} from "@opensesame/app-core/lib/capabilities/keys.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import {
  installTrustSeams,
  pendingTrustWrites,
} from "@opensesame/app-core/lib/capabilities/trust/install.js";
import { kvHydrate } from "@opensesame/app-core/lib/kv.js";
import { parseRuntimeConfig } from "@opensesame/app-core/lib/runtime-config.js";
import { overlapCast } from "@opensesame/os-domain";
import { readSecurityFile } from "./security-files.js";

/** No optional runtime, worker or UI module is present in this distribution. */
export const headlessCapabilityArtifacts: CapabilityArtifacts = {
  moduleTable: async () => ({}),
  distribution: async () => ({
    distributionId: "opensesame-id-core-v1",
    mode: "selective",
    capabilityIds: CAPABILITY_CATALOG.capabilities
      .filter((entry) => entry.tier === "core" && entry.moduleIds.length === 0)
      .map((entry) => entry.id),
    moduleIds: [],
    workerVariants: [],
    basePath: "/",
  }),
};
async function readHeadlessConfig(stateDir: string) {
  try {
    const text = await readSecurityFile(
      join(stateDir, "os-runtime-config.json"),
      65536,
    );
    return parseRuntimeConfig(overlapCast(JSON.parse(text)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return parseRuntimeConfig({});
    throw error;
  }
}
/** Re-read the actual configured profile and tomb narrowing for every human command. */
export async function bootHeadlessComposition(
  stateDir: string,
  tomb: string,
): Promise<void> {
  await kvHydrate([...CAPABILITY_BOOT_KEYS, vaultSelectionKey(tomb)]);
  const runtimeConfig = await readHeadlessConfig(stateDir);
  await ensureInstallationId();
  await installTrustSeams(runtimeConfig, tomb);
  await compositionStore.boot({
    runtimeConfig,
    vaultId: tomb,
    facts: {
      environments: [],
      serviceWorkerAvailable: false,
      activeWorkerVariant: null,
      cleanRealm: true,
      evaluatedModuleIds: [],
      approvedAtLoad: [],
      now: new Date().toISOString(),
    },
  });
  await pendingTrustWrites();
}
