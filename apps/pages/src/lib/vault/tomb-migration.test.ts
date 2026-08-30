/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDP_REGISTRY_CONFIG_PATH,
  discardIdpRegistry,
  listIdpRegistrations,
} from "../idp-registry.js";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import {
  ORG_PROFILE_CONFIG_PATH,
  activeOrgProfileId,
  discardOrgProfile,
} from "../orgs.js";
import {
  PROJECTS_CONFIG_PATH,
  PROJECTS_KEY,
  projectsState,
  rehydrateProjects,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  TOMBS_REGISTRY_KEY,
  listDir,
  lockAllTombs,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "../vfs.js";
import { mintVaultKey } from "./crypto.js";
import { PREFS_CONFIG_PATH } from "./store.js";
import {
  LEGACY_BODY_KEY,
  LEGACY_HEADER_KEY,
  LEGACY_PREFS_KEY,
  discardTombCaches,
  hydrateAndMigrateTombOnUnlock,
  migrateLegacyVaultStorage,
} from "./tomb-migration.js";

const utf8decode = new TextDecoder();
const LEGACY_IDP_KEY = "opensesame.idp-registry.v1";
const LEGACY_ORG_KEY = "opensesame:org-profile";

type StorageStub = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

/**
 * Node shadows the `localStorage` global with an unavailable experimental
 * one, so the legacy-registry tests stub it with a plain in-memory map.
 */
function stubLocalStorage(): StorageStub {
  const map = new Map<string, string>();
  const stub: StorageStub = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
  vi.stubGlobal("localStorage", stub);
  return stub;
}

const TOMB_KEYS = [
  HEADER_PATH,
  BODY_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PREFS_CONFIG_PATH,
  IDP_REGISTRY_CONFIG_PATH,
  PROJECTS_CONFIG_PATH,
  ORG_PROFILE_CONFIG_PATH,
];

function clearAll(): void {
  for (const path of TOMB_KEYS) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
    kvDelete(tombFileKey("prj_x", path));
  }
  for (const key of [
    TOMBS_REGISTRY_KEY,
    PROJECTS_KEY,
    LEGACY_HEADER_KEY,
    LEGACY_BODY_KEY,
    LEGACY_PREFS_KEY,
    `project.prj_x.${LEGACY_HEADER_KEY}`,
    `project.prj_x.${LEGACY_BODY_KEY}`,
    `project.prj_x.${LEGACY_PREFS_KEY}`,
  ]) {
    kvDelete(key);
  }
  sessionStorage.clear();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  discardTombCaches();
  clearAll();
});

async function unlockedPersonalTomb(): Promise<void> {
  const { vaultKey } = await mintVaultKey();
  unlockTomb(PERSONAL_TOMB, vaultKey);
}

function marker(): { storage?: boolean; config?: boolean } {
  return overlapCast(
    JSON.parse(
      kvGet(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH)) ?? "{}",
    ),
  );
}

describe("phase B — legacy vault storage into the tomb (pre-unlock)", () => {
  it("moves header and body verbatim, deletes the legacy keys, sets the marker", async () => {
    kvSet(LEGACY_HEADER_KEY, '{"v":1,"kdf":"params"}');
    kvSet(LEGACY_BODY_KEY, '{"ivB64":"AAAA","ctB64":"BBBB"}');
    await migrateLegacyVaultStorage(PERSONAL_TOMB);

    // Content unchanged — only the location changed.
    expect(kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH))).toBe(
      '{"v":1,"kdf":"params"}',
    );
    expect(kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH))).toBe(
      '{"ivB64":"AAAA","ctB64":"BBBB"}',
    );
    expect(kvGet(LEGACY_HEADER_KEY)).toBeNull();
    expect(kvGet(LEGACY_BODY_KEY)).toBeNull();
    expect(marker().storage).toBe(true);
  });

  it("maps a project vault to the tomb named after its project id", async () => {
    kvSet(`project.prj_x.${LEGACY_HEADER_KEY}`, '{"v":1}');
    kvSet(`project.prj_x.${LEGACY_BODY_KEY}`, '{"ivB64":"C","ctB64":"D"}');
    await migrateLegacyVaultStorage("prj_x");

    expect(kvGet(tombFileKey("prj_x", HEADER_PATH))).toBe('{"v":1}');
    expect(kvGet(tombFileKey("prj_x", BODY_PATH))).toBe(
      '{"ivB64":"C","ctB64":"D"}',
    );
    expect(kvGet(`project.prj_x.${LEGACY_HEADER_KEY}`)).toBeNull();
    expect(kvGet(`project.prj_x.${LEGACY_BODY_KEY}`)).toBeNull();
  });

  it("is idempotent: a second run changes nothing", async () => {
    kvSet(LEGACY_HEADER_KEY, '{"v":1}');
    await migrateLegacyVaultStorage(PERSONAL_TOMB);
    const header = kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    await migrateLegacyVaultStorage(PERSONAL_TOMB);
    expect(kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH))).toBe(header);
  });

  it("re-runs cleanly after a crash mid-migration (marker unset)", async () => {
    kvSet(LEGACY_HEADER_KEY, '{"v":1}');
    kvSet(LEGACY_BODY_KEY, '{"ivB64":"A","ctB64":"B"}');
    // Crashed after the header copy landed but before anything else: the new
    // file exists, the legacy keys are still there, no marker.
    kvSet(tombFileKey(PERSONAL_TOMB, HEADER_PATH), '{"v":1}');

    await migrateLegacyVaultStorage(PERSONAL_TOMB);
    expect(kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH))).toBe('{"v":1}');
    expect(kvGet(tombFileKey(PERSONAL_TOMB, BODY_PATH))).toBe(
      '{"ivB64":"A","ctB64":"B"}',
    );
    expect(kvGet(LEGACY_HEADER_KEY)).toBeNull();
    expect(kvGet(LEGACY_BODY_KEY)).toBeNull();
    expect(marker().storage).toBe(true);
  });
});

describe("phase C — config into the sealed tomb (on unlock)", () => {
  it("seals legacy prefs, deletes the legacy key, and keeps no plaintext at rest", async () => {
    await unlockedPersonalTomb();
    kvSet(LEGACY_PREFS_KEY, '{"theme":"dark","autoLockMinutes":5}');
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    const raw = kvGet(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("dark");
    expect(raw).toContain("ivB64");
    expect(
      utf8decode.decode(await readFile(PERSONAL_TOMB, PREFS_CONFIG_PATH)),
    ).toBe('{"theme":"dark","autoLockMinutes":5}');
    expect(kvGet(LEGACY_PREFS_KEY)).toBeNull();
    expect(marker().config).toBe(true);
  });

  it("moves the IdP registry out of localStorage into the sealed config", async () => {
    await unlockedPersonalTomb();
    const registry = JSON.stringify({
      version: 1,
      providers: [
        {
          id: "google",
          issuer: "http://127.0.0.1:8788",
          label: "Google",
          kind: "first-class",
          registeredAt: "2026-08-29T10:00:00Z",
        },
      ],
      ceremonyDismissed: true,
    });
    const legacy = stubLocalStorage();
    legacy.setItem(LEGACY_IDP_KEY, registry);
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    expect(legacy.getItem(LEGACY_IDP_KEY)).toBeNull();
    const raw = kvGet(tombFileKey(PERSONAL_TOMB, IDP_REGISTRY_CONFIG_PATH));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("google");
    // …and the module's in-memory view hydrated from the VFS.
    expect(listIdpRegistrations().map((record) => record.id)).toEqual([
      "google",
    ]);
  });

  it("seals the projects list per tomb and shrinks the plaintext key to the boot pointer", async () => {
    await unlockedPersonalTomb();
    kvSet(
      PROJECTS_KEY,
      JSON.stringify({
        v: 1,
        activeId: PERSONAL_TOMB,
        projects: [
          {
            id: PERSONAL_TOMB,
            name: "Personal",
            kind: "personal",
            createdAt: new Date(0).toISOString(),
          },
          {
            id: "prj_work",
            name: "Work",
            kind: "standard",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    const raw = kvGet(PROJECTS_KEY) ?? "{}";
    const boot = overlapCast<{ activeId?: string; projects?: unknown }>(
      JSON.parse(raw),
    );
    expect(boot.projects).toBeUndefined();
    expect(boot.activeId).toBe(PERSONAL_TOMB);
    expect(kvGet(tombFileKey(PERSONAL_TOMB, PROJECTS_CONFIG_PATH))).toContain(
      "ivB64",
    );
    expect(projectsState().projects.map((project) => project.id)).toEqual([
      PERSONAL_TOMB,
      "prj_work",
    ]);
    expect(
      projectsState().projects.find((project) => project.id === "prj_work")
        ?.name,
    ).toBe("Work");
  });

  it("moves the org profile out of sessionStorage", async () => {
    await unlockedPersonalTomb();
    sessionStorage.setItem(LEGACY_ORG_KEY, "org:acme");
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    expect(sessionStorage.getItem(LEGACY_ORG_KEY)).toBeNull();
    expect(
      utf8decode.decode(await readFile(PERSONAL_TOMB, ORG_PROFILE_CONFIG_PATH)),
    ).toBe("org:acme");
    expect(activeOrgProfileId()).toBe("org:acme");
  });

  it("records a pre-unlock-moved body in the sealed index", async () => {
    await unlockedPersonalTomb();
    // Phase B moved the body with no key, so the index never heard of it.
    kvSet(tombFileKey(PERSONAL_TOMB, BODY_PATH), '{"ivB64":"A","ctB64":"B"}');
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);
    expect(await listDir(PERSONAL_TOMB, "")).toContain(BODY_PATH);
  });

  it("is idempotent: a second run re-seals nothing", async () => {
    await unlockedPersonalTomb();
    kvSet(LEGACY_PREFS_KEY, '{"theme":"dark"}');
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);
    const sealedOnce = kvGet(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));

    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);
    expect(kvGet(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH))).toBe(
      sealedOnce,
    );
  });

  it("re-runs cleanly after a crash mid-migration (marker unset)", async () => {
    await unlockedPersonalTomb();
    // Crashed with prefs already moved but the registry and marker pending.
    kvSet(LEGACY_PREFS_KEY, '{"theme":"dark"}');
    const legacy = stubLocalStorage();
    legacy.setItem(LEGACY_IDP_KEY, '{"version":1,"providers":[]}');
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);
    const sealedPrefs = kvGet(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH));

    // Undo only the marker — the crash point — and re-run.
    kvDelete(tombFileKey(PERSONAL_TOMB, MIGRATION_MARKER_PATH));
    legacy.setItem(
      LEGACY_IDP_KEY,
      '{"version":1,"providers":[],"ceremonyDismissed":true}',
    );
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);

    // Already-migrated steps no-op (legacy source gone), the rest completes.
    expect(kvGet(tombFileKey(PERSONAL_TOMB, PREFS_CONFIG_PATH))).toBe(
      sealedPrefs,
    );
    expect(legacy.getItem(LEGACY_IDP_KEY)).toBeNull();
    expect(marker().config).toBe(true);
  });

  it("discards every decrypted view on lock", async () => {
    await unlockedPersonalTomb();
    sessionStorage.setItem(LEGACY_ORG_KEY, "org:acme");
    const legacy = stubLocalStorage();
    legacy.setItem(
      LEGACY_IDP_KEY,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "google",
            issuer: "http://127.0.0.1:8788",
            label: "Google",
            kind: "first-class",
            registeredAt: "2026-08-29T10:00:00Z",
          },
        ],
      }),
    );
    await hydrateAndMigrateTombOnUnlock(PERSONAL_TOMB);
    expect(listIdpRegistrations()).toHaveLength(1);
    expect(activeOrgProfileId()).toBe("org:acme");

    lockAllTombs();
    discardTombCaches();
    expect(listIdpRegistrations()).toEqual([]);
    expect(activeOrgProfileId()).toBe("guest");
    expect(projectsState().projects.map((project) => project.id)).toEqual([
      PERSONAL_TOMB,
    ]);
  });
});
