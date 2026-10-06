/** @vitest-environment jsdom */
import {
  type SealedBlob,
  mintVaultKey,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localStore, sessionStore } from "../ports.js";
import { markDecoySession } from "./decoy-session.js";
import {
  IDP_REGISTRY_CONFIG_PATH,
  clearLegacyIdpRegistry,
  discardIdpRegistry,
  hydrateIdpRegistryFromVfs,
  listAdditionalIdpRegistrations,
  registerIdp,
} from "./idp-registry.js";
import { kvDelete } from "./kv.js";
import { subscribeLocalIamChanges } from "./local-iam-events.js";
import {
  GUEST_PROFILE_ID,
  ORG_PROFILE_CONFIG_PATH,
  activeOrgProfileId,
  clearLegacyOrgProfile,
  discardOrgProfile,
  hydrateOrgProfileFromVfs,
  lookupOrgTenant,
  orgSeams,
  setActiveOrgProfileId,
  subscribeOrgProfile,
} from "./orgs.js";
import {
  lockAllTombs,
  lockTomb,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "./vfs.js";

const TOMB = "registry-authority-fixture";
const PROVIDER = {
  id: "owner-upstream",
  issuer: "https://owner.example.invalid",
  label: "Owner provider",
  kind: "byo" as const,
  clientAuth: "owner-only registry fixture",
  registeredAt: "2026-10-06T00:00:00Z",
};
const originalOpen = vfsSeams.open;
const originalLookup = orgSeams.lookupOrgTenant;

function signal() {
  let finish: () => void = () => {
    throw new Error("Signal not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}

function pauseDecryption(path: string) {
  const started = signal();
  const released = signal();
  vfsSeams.open = async function pauseActualRead<T>(
    key: CryptoKey,
    blob: SealedBlob,
    binding?: string,
  ): Promise<T> {
    const value = await originalOpen<T>(key, blob, binding);
    if (binding === vaultSealBinding(TOMB, path)) {
      started.finish();
      await released.promise;
    }
    return value;
  };
  return { started: started.promise, release: released.finish };
}

beforeEach(async () => {
  markDecoySession(false);
  discardIdpRegistry();
  discardOrgProfile();
  lockAllTombs();
  const { vaultKey } = await mintVaultKey();
  unlockTomb(TOMB, vaultKey);
  await writeFile(
    TOMB,
    IDP_REGISTRY_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify({ providers: [PROVIDER] })),
  );
  await writeFile(
    TOMB,
    ORG_PROFILE_CONFIG_PATH,
    new TextEncoder().encode("org:owner-private"),
  );
});
afterEach(async () => {
  vfsSeams.open = originalOpen;
  orgSeams.lookupOrgTenant = originalLookup;
  markDecoySession(false);
  discardIdpRegistry();
  discardOrgProfile();
  await vfsFlush();
  lockAllTombs();
  for (const path of [
    IDP_REGISTRY_CONFIG_PATH,
    ORG_PROFILE_CONFIG_PATH,
    "index",
  ])
    kvDelete(tombFileKey(TOMB, path));
  localStore().removeItem("opensesame.idp-registry.v1");
  sessionStore().removeItem("opensesame:org-profile");
});

const subjects = [
  { path: IDP_REGISTRY_CONFIG_PATH, hydrate: hydrateIdpRegistryFromVfs },
  { path: ORG_PROFILE_CONFIG_PATH, hydrate: hydrateOrgProfileFromVfs },
];

it.each(subjects)(
  "does not install $path from a real read completed in a synthetic realm",
  async ({ path, hydrate }) => {
    const held = pauseDecryption(path);
    const pending = hydrate(TOMB);
    const rejection = expect(pending).rejects.toThrow();
    await held.started;
    markDecoySession(true);
    held.release();
    await rejection;
    expect(listAdditionalIdpRegistrations()).toEqual([]);
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
    markDecoySession(false);
    expect(listAdditionalIdpRegistrations()).toEqual([]);
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
  },
);

it.each(subjects)(
  "does not install $path after the admitted tomb key is replaced",
  async ({ path, hydrate }) => {
    const replacement = await mintVaultKey();
    const held = pauseDecryption(path);
    const pending = hydrate(TOMB);
    const rejection = expect(pending).rejects.toThrow();
    await held.started;
    lockTomb(TOMB);
    unlockTomb(TOMB, replacement.vaultKey);
    held.release();
    await rejection;
    expect(listAdditionalIdpRegistrations()).toEqual([]);
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
  },
);

it("allows current-owner hydration and writes, but hides existing caches on realm change", async () => {
  await hydrateIdpRegistryFromVfs(TOMB);
  await hydrateOrgProfileFromVfs(TOMB);
  expect(listAdditionalIdpRegistrations()).toEqual([PROVIDER]);
  expect(activeOrgProfileId()).toBe("org:owner-private");
  registerIdp({ ...PROVIDER, label: "Owner update" });
  setActiveOrgProfileId("org:owner-new");
  await vfsFlush();
  expect(listAdditionalIdpRegistrations()[0]?.label).toBe("Owner update");
  expect(activeOrgProfileId()).toBe("org:owner-new");
  expect(
    new TextDecoder().decode(await readFile(TOMB, ORG_PROFILE_CONFIG_PATH)),
  ).toBe("org:owner-new");
  expect(
    new TextDecoder().decode(await readFile(TOMB, IDP_REGISTRY_CONFIG_PATH)),
  ).toContain("Owner update");
  markDecoySession(true);
  expect(listAdditionalIdpRegistrations()).toEqual([]);
  expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
  markDecoySession(false);
  expect(listAdditionalIdpRegistrations()).toEqual([]);
  expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
});

it("refuses synthetic mutations, notifications, and legacy deletions", async () => {
  localStore().setItem("opensesame.idp-registry.v1", "owner legacy fixture");
  sessionStore().setItem("opensesame:org-profile", "org:owner-legacy");
  let notifications = 0;
  const unsubIdp = subscribeLocalIamChanges(() => {
    notifications += 1;
  });
  const unsubOrg = subscribeOrgProfile(() => {
    notifications += 1;
  });
  try {
    markDecoySession(true);
    expect(() => registerIdp(PROVIDER)).toThrow();
    expect(() => setActiveOrgProfileId("org:synthetic-write")).toThrow();
    expect(() => clearLegacyIdpRegistry()).toThrow();
    expect(() => clearLegacyOrgProfile()).toThrow();
    expect(notifications).toBe(0);
    expect(localStore().getItem("opensesame.idp-registry.v1")).toBe(
      "owner legacy fixture",
    );
    expect(sessionStore().getItem("opensesame:org-profile")).toBe(
      "org:owner-legacy",
    );
  } finally {
    unsubIdp();
    unsubOrg();
  }
});

it("pins injected directory calls across the await and permits the current owner", async () => {
  const tenant = {
    slug: "owner",
    displayName: "Owner directory",
    state: "active",
    authMethods: [],
  };
  orgSeams.lookupOrgTenant = async () => tenant;
  expect(await lookupOrgTenant("owner")).toEqual(tenant);
  const started = signal();
  const released = signal();
  orgSeams.lookupOrgTenant = async () => {
    started.finish();
    await released.promise;
    return tenant;
  };
  const pending = lookupOrgTenant("owner");
  const rejection = expect(pending).rejects.toThrow();
  await started.promise;
  markDecoySession(true);
  released.finish();
  await rejection;
});

it.each(subjects)(
  "rejects $path from a predecessor even if a real successor is active",
  async ({ path, hydrate }) => {
    const held = pauseDecryption(path);
    const pending = hydrate(TOMB);
    const rejection = expect(pending).rejects.toThrow();
    await held.started;
    markDecoySession(true);
    markDecoySession(false);
    held.release();
    await rejection;
    expect(listAdditionalIdpRegistrations()).toEqual([]);
    expect(activeOrgProfileId()).toBe(GUEST_PROFILE_ID);
  },
);

it("does not return registry data after a listener changes realms", async () => {
  await hydrateIdpRegistryFromVfs(TOMB);
  await hydrateOrgProfileFromVfs(TOMB);
  const unsubscribe = subscribeLocalIamChanges(() => {
    markDecoySession(true);
  });
  try {
    expect(() => registerIdp({ ...PROVIDER, label: "Owner update" })).toThrow();
  } finally {
    unsubscribe();
  }
});

it("does not continue profile notifications after a listener changes realms", async () => {
  await hydrateOrgProfileFromVfs(TOMB);
  const first = subscribeOrgProfile(() => {
    markDecoySession(true);
  });
  let lateNotifications = 0;
  const second = subscribeOrgProfile(() => {
    lateNotifications += 1;
  });
  try {
    expect(() => setActiveOrgProfileId("org:owner-new")).toThrow();
    expect(lateNotifications).toBe(0);
  } finally {
    first();
    second();
  }
});
