import { expect, it, vi } from "vitest";
import * as kv from "../kv.js";
import * as orgs from "../orgs.js";
import * as projects from "../projects.js";
import * as vfs from "../vfs.js";
import * as preferences from "./prefs-io.js";
import * as selfAuth from "./self-authenticator.js";
import { PASSWORD, newStore } from "./store-ops.fixture.js";
import {
  MARKER_PATH,
  deferred,
  holdProjection,
  installUnlockRacesFixture,
  pendingLegacyTotp,
  pendingTotp,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

it("a retired projects hydration never republishes decrypted project names", async () => {
  const source = newStore();
  await source.create(PASSWORD);
  const sibling = `prj_${crypto.randomUUID()}`;
  await vfs.registerTomb(sibling);
  await vfs.writeFile(
    "personal",
    projects.PROJECTS_CONFIG_PATH,
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        activeId: "personal",
        projects: [
          {
            id: "personal",
            name: "Personal",
            kind: "personal",
            createdAt: "2026-01-01",
          },
          {
            id: sibling,
            name: "Sealed project marker",
            kind: "standard",
            createdAt: "2026-01-01",
          },
        ],
      }),
    ),
  );
  source.lock();
  const store = newStore();
  const started = deferred();
  const gate = deferred();
  const refresh = kv.kvRefresh;
  vi.spyOn(kv, "kvRefresh").mockImplementation(async (key, ...args) => {
    const result = await refresh(key, ...args);
    if (key === vfs.TOMBS_REGISTRY_KEY) {
      started.release();
      await gate.promise;
    }
    return result;
  });
  const refused = expect(store.unlock(PASSWORD)).rejects.toThrow(
    /no longer pending/,
  );
  await started.promise;
  try {
    store.lock();
    gate.release();
    await refused;
    expect(store.isUnlocked()).toBe(false);
    expect(
      projects.projectsState().projects.map((project) => project.name),
    ).not.toContain("Sealed project marker");
  } finally {
    gate.release();
    await refused;
  }
});

it("a queued lock before org hydration resumes never restores the sealed selection", async () => {
  const source = newStore();
  await source.create(PASSWORD);
  await vfs.writeFile(
    "personal",
    orgs.ORG_PROFILE_CONFIG_PATH,
    new TextEncoder().encode("SEALED-ORG-MARKER"),
  );
  source.lock();
  const store = newStore();
  const read = vfs.readFile;
  vi.spyOn(vfs, "readFile").mockImplementation(async (tomb, path) => {
    const bytes = await read(tomb, path);
    if (path === orgs.ORG_PROFILE_CONFIG_PATH)
      queueMicrotask(() => store.lock());
    return bytes;
  });
  await expect(store.unlock(PASSWORD)).rejects.toThrow(/no longer pending/);
  expect(store.isUnlocked()).toBe(false);
  expect(orgs.activeOrgProfileId()).toBe(orgs.GUEST_PROFILE_ID);
});

it("transport refusal clears the original key even when the transport identity changed", async () => {
  const { store, code } = await pendingTotp();
  const held = holdProjection(store);
  const refused = expect(store.confirmTotp(await code())).rejects.toThrow(
    /transport changed/,
  );
  await held.started;
  try {
    const read = vfs.vfsSeams.readRaw;
    vi.spyOn(vfs.vfsSeams, "readRaw").mockImplementation((key) => read(key));
    held.release();
    await refused;
    store.cancelTotpChallenge();
    expect(store.isUnlocked()).toBe(false);
    await expect(vfs.readFile("personal", MARKER_PATH)).rejects.toMatchObject({
      code: "locked",
    });
  } finally {
    held.release();
    await refused;
  }
});

it("a delayed failed preference write cannot disable a subsequently enabled idle lock", async () => {
  const store = newStore();
  await store.create(PASSWORD);
  await store.commitPrefs({ autoLockMinutes: 0, theme: "system" });
  await store.flushPendingWrites();
  const started = deferred();
  const gate = deferred();
  const read = preferences.readPrefsJson;
  vi.spyOn(preferences, "writePrefsJson").mockRejectedValueOnce(
    new Error("disk write failed"),
  );
  vi.spyOn(preferences, "readPrefsJson").mockImplementationOnce(
    async (tomb) => {
      const prefs = await read(tomb);
      started.release();
      await gate.promise;
      return prefs;
    },
  );
  store.setPrefs({ theme: "dark" });
  await started.promise;
  try {
    store.setPrefs({ autoLockMinutes: 5 });
    gate.release();
    await store.flushPendingWrites();
    expect(store.getSnapshot().prefs.autoLockMinutes).toBe(5);
    expect(await read("personal")).toMatchObject({ autoLockMinutes: 5 });
  } finally {
    gate.release();
    await store.flushPendingWrites();
  }
});

it("late legacy authenticator registration cannot copy the old seed into a new guest scope", async () => {
  const { store, code } = await pendingLegacyTotp();
  const started = deferred();
  const gate = deferred();
  const register = selfAuth.withSelfAuthenticatorRegistration;
  vi.spyOn(
    selfAuth,
    "withSelfAuthenticatorRegistration",
  ).mockImplementationOnce(async (...args) => {
    const next = await register(...args);
    started.release();
    await gate.promise;
    return next;
  });
  const refused = expect(store.confirmTotp(await code())).rejects.toMatchObject(
    { code: "stale_operation" },
  );
  await started.promise;
  try {
    store.lock();
    store.prepareGuestUnlock();
    await store.createGuest();
    const guest = store.activeTomb();
    gate.release();
    await refused;
    expect(store.activeTomb()).toBe(guest);
    expect(store.isUnlocked()).toBe(true);
    expect(store.getSnapshot().items).toEqual([]);
  } finally {
    gate.release();
    await refused;
  }
});
