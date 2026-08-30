import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
} from "@opensesame/os-domain";
/**
 * Legacy → tomb migration (ADR 0063). Every vault is a tomb; the encrypted
 * VFS (`lib/vfs.ts`) holds what flat KV keys and web storage used to hold.
 *
 * Two idempotent phases, each gated by the plaintext `tomb/<name>/migrated.v1`
 * marker and safe to re-run after a crash (marker unset → re-run; every step
 * no-ops when its legacy source is already gone):
 *
 * - Phase B, `migrateLegacyVaultStorage` — pre-unlock, plaintext moves only.
 *   The legacy scoped header/body keys become `tomb/<name>/header`
 *   (plaintext params by design) and `tomb/<name>/body` (already store-sealed
 *   — the bytes move unchanged, no key needed).
 * - Phase C, `hydrateAndMigrateTombOnUnlock` — on unlock, with the tomb key
 *   available. Legacy prefs, the IdP registry (leaves localStorage), the
 *   projects list, and the org profile (leaves sessionStorage) are sealed
 *   into `tomb/<name>/config/*`, the legacy copies are deleted, and each
 *   module hydrates its in-memory view from the VFS.
 *
 * Stays plaintext by design (documented boundary): boot endpoints
 * (`settings.v1`), the vault header, lockout counters, tomb names.
 */

import {
  IDP_REGISTRY_CONFIG_PATH,
  clearLegacyIdpRegistry,
  discardIdpRegistry,
  hydrateIdpRegistryFromVfs,
  readLegacyIdpRegistry,
} from "../idp-registry.js";
import { kvHydrate } from "../kv.js";
import {
  ORG_PROFILE_CONFIG_PATH,
  clearLegacyOrgProfile,
  discardOrgProfile,
  hydrateOrgProfileFromVfs,
  readLegacyOrgProfile,
} from "../orgs.js";
import {
  PROJECTS_CONFIG_PATH,
  hydrateProjectsFromVfs,
  migrateProjectsToVfs,
  rehydrateProjects,
  scopedKey,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  ensureIndexed,
  readPlaintextFile,
  tombFileKey,
  vfsSeams,
  writeFile,
  writePlaintextFile,
} from "../vfs.js";
import { PREFS_CONFIG_PATH } from "./store.js";

/** Legacy flat-KV base keys (still scoped per project via `scopedKey`). */
export const LEGACY_HEADER_KEY = "vault.header.v1";
export const LEGACY_BODY_KEY = "vault.body.v1";
// gitleaks:allow -- storage key name, not a credential
export const LEGACY_PREFS_KEY = "vault.prefs.v1";

type TombMigrationMarker = { v: 1; storage: boolean; config: boolean };

function readMarker(tomb: string): TombMigrationMarker {
  const raw = readPlaintextFile(tomb, MIGRATION_MARKER_PATH);
  if (!raw) return { v: 1, storage: false, config: false };
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return { v: 1, storage: false, config: false };
    return {
      v: 1,
      storage: isBoolean(parsed.storage) ? parsed.storage : false,
      config: isBoolean(parsed.config) ? parsed.config : false,
    };
  } catch {
    return { v: 1, storage: false, config: false };
  }
}

async function writeMarker(
  tomb: string,
  marker: TombMigrationMarker,
): Promise<void> {
  await writePlaintextFile(tomb, MIGRATION_MARKER_PATH, JSON.stringify(marker));
}

/**
 * Tomb paths the boot path hydrates before first paint: everything the
 * locked vault may read — the plaintext header, the (sealed) body, and the
 * migration marker. Config and the index stay untouched until unlock.
 */
export function tombStorageKeys(tomb: string): string[] {
  return [
    tombFileKey(tomb, HEADER_PATH),
    tombFileKey(tomb, BODY_PATH),
    tombFileKey(tomb, MIGRATION_MARKER_PATH),
  ];
}

/** Tomb paths hydrate-on-unlock: the sealed index and every config file. */
function tombSessionKeys(tomb: string): string[] {
  return [
    tombFileKey(tomb, INDEX_PATH),
    tombFileKey(tomb, PREFS_CONFIG_PATH),
    tombFileKey(tomb, IDP_REGISTRY_CONFIG_PATH),
    tombFileKey(tomb, PROJECTS_CONFIG_PATH),
    tombFileKey(tomb, ORG_PROFILE_CONFIG_PATH),
  ];
}

/**
 * Phase B — move the legacy scoped vault header/body keys into the tomb.
 * Pre-unlock safe: the header is plaintext params and the body is already
 * sealed, so both move verbatim with no key. Idempotent via the marker.
 */
export async function migrateLegacyVaultStorage(tomb: string): Promise<void> {
  const marker = readMarker(tomb);
  if (marker.storage) return;

  // The tomb name IS the legacy project id (1:1), so the legacy scoped key
  // scheme addresses the same vault.
  const legacyHeader = vfsSeams.readRaw(scopedKey(LEGACY_HEADER_KEY, tomb));
  if (legacyHeader !== null) {
    await writePlaintextFile(tomb, HEADER_PATH, legacyHeader);
    await vfsSeams.deleteRaw(scopedKey(LEGACY_HEADER_KEY, tomb));
  }

  const legacyBody = vfsSeams.readRaw(scopedKey(LEGACY_BODY_KEY, tomb));
  if (legacyBody !== null) {
    // Store-sealed ciphertext: the bytes move unchanged (content unchanged,
    // location changes). The sealed index is reconciled on unlock.
    await vfsSeams.writeRaw(tombFileKey(tomb, BODY_PATH), legacyBody);
    await vfsSeams.deleteRaw(scopedKey(LEGACY_BODY_KEY, tomb));
  }

  await writeMarker(tomb, { ...marker, storage: true });
}

const utf8 = new TextEncoder();

/**
 * Phase C — seal legacy config into the tomb and hydrate every module's
 * in-memory view from the VFS. Runs on unlock, when the tomb key exists.
 */
export async function hydrateAndMigrateTombOnUnlock(
  tomb: string,
): Promise<void> {
  await kvHydrate(tombSessionKeys(tomb));

  const marker = readMarker(tomb);
  if (!marker.config) {
    const legacyPrefs = vfsSeams.readRaw(scopedKey(LEGACY_PREFS_KEY, tomb));
    if (legacyPrefs !== null) {
      await writeFile(tomb, PREFS_CONFIG_PATH, utf8.encode(legacyPrefs));
      await vfsSeams.deleteRaw(scopedKey(LEGACY_PREFS_KEY, tomb));
    }

    const legacyRegistry = readLegacyIdpRegistry();
    if (legacyRegistry !== null) {
      await writeFile(
        tomb,
        IDP_REGISTRY_CONFIG_PATH,
        utf8.encode(legacyRegistry),
      );
      clearLegacyIdpRegistry();
    }

    // The projects list seals into this tomb's config; the plaintext
    // `projects.v1` shrinks to the boot pointer (the active tomb name).
    await migrateProjectsToVfs(tomb);

    const legacyProfile = readLegacyOrgProfile();
    if (legacyProfile !== null) {
      await writeFile(
        tomb,
        ORG_PROFILE_CONFIG_PATH,
        utf8.encode(legacyProfile),
      );
      clearLegacyOrgProfile();
    }

    // Phase B moved the body without a key, so it never reached the sealed
    // index — record it now that the index can be written.
    await ensureIndexed(tomb, BODY_PATH);

    await writeMarker(tomb, { ...marker, config: true });
  }

  await hydrateIdpRegistryFromVfs(tomb);
  await hydrateProjectsFromVfs(tomb);
  await hydrateOrgProfileFromVfs(tomb);
}

/**
 * Drop every decrypted config cache on lock: the registry, the projects
 * list, and the org profile become unreadable until the next unlock.
 */
export function discardTombCaches(): void {
  discardIdpRegistry();
  discardOrgProfile();
  rehydrateProjects();
}

/**
 * Wipe a tomb's sealed area after its vault is destroyed. The vault key is
 * unrecoverable at that point, so everything sealed under it — the index,
 * the config files — is unreadable ciphertext; leaving it would break a
 * fresh vault created in the same tomb (its key cannot open the old index).
 * The migration marker goes too, so the next vault starts from a clean slate.
 */
export async function wipeTombOnDestroy(tomb: string): Promise<void> {
  await Promise.all(
    [...tombSessionKeys(tomb), tombFileKey(tomb, MIGRATION_MARKER_PATH)].map(
      (key) => vfsSeams.deleteRaw(key),
    ),
  );
}
