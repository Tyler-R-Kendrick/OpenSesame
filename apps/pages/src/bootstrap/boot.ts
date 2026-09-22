/**
 * Core-only boot (ownership.md §3, S05). Runs before the first paint and
 * before any optional code exists in this document: deployment config, the
 * plaintext boundary, the active tomb, the vault header, and the resolved
 * composition plan. Only when the plan is known does `main.tsx` import the
 * shell — so the entry chunk carries no optional system, and nothing optional
 * can run before a person's selection has been read.
 */

import { compositionStore } from "../lib/capabilities/store.js";
import { collectRuntimeFacts } from "../lib/capabilities/facts.js";
import { ensureInstallationId } from "../lib/capabilities/installation.js";
import { startInvalidationWatch, vaultIdOf } from "../lib/capabilities/invalidation.js";
import { vaultSelectionKey } from "../lib/capabilities/keys.js";
import { kvHydrate } from "../lib/kv.js";
import {
  activeProject,
  projectScopedKeys,
  rehydrateProjects,
} from "../lib/projects.js";
import { type ParsedRuntimeConfig, loadRuntimeConfig } from "../lib/runtime-config.js";
import { bootstrapTheme } from "../lib/theme.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "../lib/vault/tomb-migration.js";
import { CORE_BOOT_KEYS } from "./core-keys.js";

export type CoreBoot = Readonly<{
  runtimeConfig: ParsedRuntimeConfig;
  /** Stop the cross-context invalidation watch (tests). */
  stopWatching: () => void;
}>;

export const bootSeams = {
  now: (): string => new Date().toISOString(),
};

export async function bootCore(): Promise<CoreBoot> {
  // OPFS is async and the store reads its header synchronously, so pull the
  // persisted keys into the KV cache and re-read before the first paint.
  // Deployment endpoints load before settings are first read, so an unbaked
  // static deploy still knows its Identity API without a rebuild.
  const runtimeConfig = await loadRuntimeConfig();
  await kvHydrate([...CORE_BOOT_KEYS]);
  rehydrateProjects();
  const tomb = activeProject().id;
  await kvHydrate([
    ...projectScopedKeys(),
    ...tombStorageKeys(tomb),
    vaultSelectionKey(tomb),
  ]);
  // Move any legacy flat vault keys into the tomb before the store reads it.
  // Pre-unlock this is plaintext moves only (header params, sealed body
  // bytes); sealed config migrates on unlock.
  await migrateLegacyVaultStorage(tomb);
  vaultStore.rehydrate();
  bootstrapTheme();

  await ensureInstallationId();
  await compositionStore.boot({
    runtimeConfig,
    vaultId: vaultIdOf(vaultStore.getSnapshot()),
    facts: collectRuntimeFacts({
      activeWorkerVariant: null,
      now: bootSeams.now(),
    }),
  });
  const stopWatching = startInvalidationWatch(compositionStore);
  return { runtimeConfig, stopWatching };
}
