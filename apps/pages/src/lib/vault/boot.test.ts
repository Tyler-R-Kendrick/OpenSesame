import { afterEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvGet, kvHydrate, kvSet } from "../kv.js";
import {
  PROJECTS_KEY,
  activeProject,
  projectScopedKeys,
  rehydrateProjects,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  lockAllTombs,
  tombFileKey,
  vfsFlush,
  vfsSeams,
} from "../vfs.js";
import { vaultStore } from "./store.js";
import {
  LEGACY_BODY_KEY,
  LEGACY_HEADER_KEY,
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "./tomb-migration.js";

/**
 * Boot-path boundary (ADR 0063): before unlock the app may read only the
 * documented plaintext surface — boot endpoints (`settings.v1`), the vault
 * header (public params), lockout counters, and tomb names — plus sealed
 * ciphertext it cannot open (the body). The sealed VFS (config, index,
 * drops) stays untouched until a key exists.
 */

const touched = vi.hoisted(() => ({ keys: new Set<string>(), crypto: 0 }));

const originalVfsSeams = { ...vfsSeams };
Object.assign(vfsSeams, {
  readRaw: (key: string): string | null => {
    touched.keys.add(key);
    return originalVfsSeams.readRaw(key);
  },
  writeRaw: async (key: string, value: string): Promise<void> => {
    touched.keys.add(key);
    return originalVfsSeams.writeRaw(key, value);
  },
  seal: async (...args: Parameters<typeof originalVfsSeams.seal>) => {
    touched.crypto += 1;
    return originalVfsSeams.seal(...args);
  },
  open: async (...args: Parameters<typeof originalVfsSeams.open>) => {
    touched.crypto += 1;
    return originalVfsSeams.open(...args);
  },
});

const SEALED_VFS_RE = /^tomb\/[^/]+\/(config|drops)\//;

function clearBootKeys(): void {
  for (const key of [
    PROJECTS_KEY,
    TOMBS_REGISTRY_KEY,
    "settings.v1",
    LEGACY_HEADER_KEY,
    LEGACY_BODY_KEY,
    tombFileKey(PERSONAL_TOMB, HEADER_PATH),
    tombFileKey(PERSONAL_TOMB, BODY_PATH),
    tombFileKey(PERSONAL_TOMB, INDEX_PATH),
    tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH),
  ]) {
    kvDelete(key);
  }
}

afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  clearBootKeys();
  touched.keys.clear();
  touched.crypto = 0;
});

/** The boot sequence from main.tsx, up to (not including) first paint. */
async function boot(): Promise<void> {
  await kvHydrate([
    PROJECTS_KEY,
    TOMBS_REGISTRY_KEY,
    "settings.v1",
    "outbox.v1",
    "connections.firstRun.v1",
  ]);
  rehydrateProjects();
  const tomb = activeProject().id;
  await kvHydrate([...projectScopedKeys(), ...tombStorageKeys(tomb)]);
  await migrateLegacyVaultStorage(tomb);
  vaultStore.rehydrate();
}

describe("pre-unlock boot path", () => {
  it("reads only the plaintext boundary — no sealed VFS access", async () => {
    kvSet("settings.v1", JSON.stringify({ hostApi: "http://127.0.0.1:18787" }));
    kvSet(LEGACY_HEADER_KEY, '{"v":1,"createdAt":"2026-08-29T00:00:00Z"}');
    kvSet(LEGACY_BODY_KEY, '{"ivB64":"AAAA","ctB64":"BBBB"}');

    await boot();

    // The legacy vault migrated: the store now sees a locked personal tomb.
    expect(vaultStore.getSnapshot().status).toBe("locked");
    expect(kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH))).toContain('"v":1');

    // Nothing under config/, drops/, or the index was read or written, and
    // not a single seal/open ran — there is no key before unlock.
    for (const key of touched.keys) {
      expect(key).not.toMatch(SEALED_VFS_RE);
      expect(key).not.toMatch(/^tomb\/[^/]+\/index$/);
    }
    expect(touched.crypto).toBe(0);

    // Every key the boot path did touch is inside the documented plaintext
    // boundary: tomb names, the header (public params), the sealed body
    // ciphertext, the migration marker, and legacy flat keys being moved.
    // (Boot endpoints in `settings.v1` hydrate through the kv layer and
    // never pass through the VFS at all.)
    const PLAINTEXT_BOUNDARY_RE =
      /^(projects\.v1|tombs\.v1|vault\.[a-z]+\.v1|site-broker\.[a-z]+\.v1|tomb\/[^/]+\/(header|body|migrated\.v1))$/;
    for (const key of touched.keys) {
      expect(key).toMatch(PLAINTEXT_BOUNDARY_RE);
    }
    // The header WAS read — it is the one vault file the lock screen needs.
    expect(
      touched.keys.has(tombFileKey(PERSONAL_TOMB, HEADER_PATH)) ||
        touched.keys.has(LEGACY_HEADER_KEY),
    ).toBe(true);
  });
});
