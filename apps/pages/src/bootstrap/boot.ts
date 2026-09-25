/**
 * Core-only boot (ownership.md §3, S05). Runs before the first paint and
 * before any optional code exists in this document: deployment config, the
 * plaintext boundary, the active tomb, the vault header, and the resolved
 * composition plan. Only when the plan is known does `main.tsx` import the
 * shell — so the entry chunk carries no optional system, and nothing optional
 * can run before a person's selection has been read.
 */

import { collectRuntimeFacts } from "@opensesame/app-core/lib/capabilities/facts.js";
import { ensureInstallationId } from "@opensesame/app-core/lib/capabilities/installation.js";
import {
  startInvalidationWatch,
  vaultIdOf,
} from "@opensesame/app-core/lib/capabilities/invalidation.js";
import { vaultSelectionKey } from "@opensesame/app-core/lib/capabilities/keys.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { captureClaimArrivalFromPage } from "@opensesame/app-core/lib/claims/arrival.js";
import { captureDeviceLinkFromPage } from "@opensesame/app-core/lib/device-link.js";
import {
  captureInviteFromPage,
  watchInviteArrivals,
} from "@opensesame/app-core/lib/join/invite.js";
import { kvHydrate } from "@opensesame/app-core/lib/kv.js";
import { lastVaultIsGuest } from "@opensesame/app-core/lib/last-vault.js";
import {
  activeProject,
  projectScopedKeys,
  rehydrateProjects,
} from "@opensesame/app-core/lib/projects.js";
import {
  type ParsedRuntimeConfig,
  loadRuntimeConfig,
} from "@opensesame/app-core/lib/runtime-config.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "@opensesame/app-core/lib/vault/tomb-migration.js";
import { GUEST_TOMB } from "@opensesame/app-core/lib/vfs.js";
import { bootstrapTheme } from "../lib/theme.js";
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
  // An invite's bearer leaves the address bar before anything else runs or
  // paints: history, a bookmark or a shared screen must never carry it.
  captureInviteFromPage();
  watchInviteArrivals();
  // A device link's user code, and the older shapes that now open `/device`,
  // leave the address here too — before the router reads `?code=` as a
  // sign-in callback (ADR 0140 plan step 7).
  captureDeviceLinkFromPage();
  // A claim or drop link's bearer — and a drop's key — leave `/claim`'s
  // fragment the same way; the route behind unlock takes them from memory
  // (ADR 0140 plan step 8).
  captureClaimArrivalFromPage();
  // OPFS is async and the store reads its header synchronously, so pull the
  // persisted keys into the KV cache and re-read before the first paint.
  // Deployment endpoints load before settings are first read, so an unbaked
  // static deploy still knows its Identity API without a rebuild.
  const runtimeConfig = await loadRuntimeConfig();
  await kvHydrate([...CORE_BOOT_KEYS]);
  rehydrateProjects();
  // The active project's plaintext boundary is what legacy storage migrates
  // into. But the tomb the unlock screen will ask about is the guest tomb
  // when that was the last authorized account (AGENTS.md §5), so its header
  // has to be hydrated too: reading only the active project left a guest's
  // enrolled gate unreadable on reload, and the unlock form then offered a
  // road with no challenge behind it (#467).
  const tomb = activeProject().id;
  const guestTomb = lastVaultIsGuest() ? GUEST_TOMB : null;
  await kvHydrate([
    ...projectScopedKeys(),
    ...tombStorageKeys(tomb),
    ...(guestTomb ? tombStorageKeys(guestTomb) : []),
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
