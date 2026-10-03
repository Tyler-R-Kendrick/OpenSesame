/**
 * The plugin-daemon pairing follows the open vault: sealed in its tomb,
 * gone the moment it locks, back once it opens again, never for a guest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete } from "../kv.js";
import { vaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import {
  currentPluginPairing,
  dropPluginPairing,
  keepPluginPairing,
  pluginPairingPossible,
  pluginPairingRevision,
  subscribePluginPairing,
} from "./plugin-daemon-store.js";
import {
  type PluginDaemonPairing,
  readPluginDaemonConfig,
} from "./plugin-pairing.js";

const PASSWORD = "correct horse battery staple";
const PAIRED: PluginDaemonPairing = {
  url: "https://desk.tail4c2e.ts.net",
  token: "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMSE",
  origin: "https://tyler-r-kendrick.github.io",
  label: "Desk",
};

function wipePersonalTomb(): void {
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
}

/** Resolves once the store has told its listeners something. */
function nextChange(): Promise<void> {
  return new Promise((resolve) => {
    const stop = subscribePluginPairing(() => {
      stop();
      resolve();
    });
  });
}

let stop: () => void = () => {};

beforeEach(async () => {
  await vfsFlush();
  wipePersonalTomb();
});

afterEach(() => {
  stop();
  if (vaultStore.isUnlocked()) vaultStore.lock();
  vi.restoreAllMocks();
});

describe("the plugin-daemon pairing", () => {
  it("is impossible, and nothing is kept, with no vault open", async () => {
    stop = subscribePluginPairing(() => {});
    expect(pluginPairingPossible()).toBe(false);
    expect(currentPluginPairing()).toBeNull();
    await expect(keepPluginPairing(PAIRED)).rejects.toThrow();
  });

  it("is sealed in the open vault, gone when it locks, and back when it opens", async () => {
    await vaultStore.create(PASSWORD);
    const told = vi.fn();
    stop = subscribePluginPairing(told);
    expect(pluginPairingPossible()).toBe(true);
    await keepPluginPairing(PAIRED);
    expect(currentPluginPairing()).toEqual(PAIRED);
    expect(told).toHaveBeenCalled();
    expect(await readPluginDaemonConfig(vaultStore.activeTomb())).toEqual(
      PAIRED,
    );
    vaultStore.lock();
    expect(currentPluginPairing()).toBeNull();
    const reopened = nextChange();
    await vaultStore.unlock(PASSWORD);
    await reopened;
    expect(currentPluginPairing()).toEqual(PAIRED);
  });

  it("forgets the pairing in the vault as well as in memory", async () => {
    await vaultStore.create(PASSWORD);
    stop = subscribePluginPairing(() => {});
    await keepPluginPairing(PAIRED);
    await dropPluginPairing();
    expect(currentPluginPairing()).toBeNull();
    expect(await readPluginDaemonConfig(vaultStore.activeTomb())).toBeNull();
  });

  it("moves its revision whenever the pairing does, and keeps no key in it", async () => {
    await vaultStore.create(PASSWORD);
    stop = subscribePluginPairing(() => {});
    const seen = [pluginPairingRevision()];
    await keepPluginPairing(PAIRED);
    seen.push(pluginPairingRevision());
    // The same daemon, paired again with a rotated key.
    await keepPluginPairing({ ...PAIRED, token: `${PAIRED.token.slice(1)}A` });
    seen.push(pluginPairingRevision());
    await dropPluginPairing();
    seen.push(pluginPairingRevision());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every((n) => Number.isInteger(n))).toBe(true);
  });

  it("is never kept for a guest", async () => {
    await vaultStore.createGuest();
    stop = subscribePluginPairing(() => {});
    expect(pluginPairingPossible()).toBe(false);
    await expect(keepPluginPairing(PAIRED)).rejects.toThrow();
    expect(currentPluginPairing()).toBeNull();
  });
});
