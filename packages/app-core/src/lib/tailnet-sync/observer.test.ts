/**
 * The observer against Chrome's Local Network Access gate (ADR 0144): a pass
 * nobody asked for never raises the browser's prompt, a person's own pass may
 * and waits for the answer, a refusal says where to undo it — and a device
 * catches up when the app is looked at again or comes back online.
 */
import { overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import type {
  EnvironmentPort,
  LocalNetworkPermission,
  PagePort,
} from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { kvDelete } from "../kv.js";
import { type PagesProject, projectSeams } from "../projects.js";
import { VaultStore, vaultStore } from "../vault/store.js";
import { vaultsSeams } from "../vaults.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  listTombs,
  readPlaintextFile,
  tombFileKey,
  unregisterTomb,
  vfsFlush,
} from "../vfs.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import {
  NETWORK_DENIED,
  NETWORK_PROMPT,
  NETWORK_STILL_ASKING,
  PROMPT_WAIT_MS,
  networkAccessSeams,
} from "./network-access.js";
import {
  pairTailnetDrive,
  startTailnetSync,
  stopTailnetSync,
  syncTailnetNow,
  tailnetSyncSeams,
  tailnetSyncState,
} from "./observer.js";
import { type DrivePairing, formatPairingCode } from "./pairing.js";
import { buildDriveSnapshot } from "./snapshot.js";

const PASSWORD = "correct horse battery staple";
const CODE = formatPairingCode(PAIRING);
const original = { ...tailnetSyncSeams };
const originalQuery = networkAccessSeams.query;

let access: LocalNetworkPermission = "granted";
let drive: MemoryDrive;
let reached: number[];
let visibility: DocumentVisibilityState = "visible";
const onVisible = new Set<() => void>();
const onOnline = new Set<(online: boolean) => void>();

const page: PagePort = overlapCast({
  get visibilityState() {
    return visibility;
  },
  onVisibilityChange(listener: () => void) {
    onVisible.add(listener);
    return () => onVisible.delete(listener);
  },
});

const environment: EnvironmentPort = overlapCast({
  online: true,
  onOnlineChange(listener: (online: boolean) => void) {
    onOnline.add(listener);
    return () => onOnline.delete(listener);
  },
});

function wipePersonalTomb(): void {
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ])
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
}

/** Let queued passes and the vault's own writes settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vaultStore.flushPendingWrites();
  }
}

beforeEach(async () => {
  configureHost(createTestHost({ page, environment }));
  await vfsFlush();
  wipePersonalTomb();
  access = "granted";
  reached = [];
  drive = memoryDrive();
  onVisible.clear();
  onOnline.clear();
  networkAccessSeams.query = async () => access;
  Object.assign(tailnetSyncSeams, {
    transport: drive,
    reach: async (_pairing: DrivePairing, waitMs: number) => {
      reached.push(waitMs);
    },
    debounceMs: 1,
    intervalMs: 3_600_000,
  });
  await vaultStore.create(PASSWORD);
  startTailnetSync();
  await settle();
});

afterEach(async () => {
  stopTailnetSync();
  Object.assign(tailnetSyncSeams, original);
  networkAccessSeams.query = originalQuery;
  // Destroy, not lock: the drive pairing is sealed in the tomb's config, and a
  // next test's vault (a new key) must not find this one's.
  await vaultStore.flushPendingWrites();
  await vaultStore.destroy();
  await vfsFlush();
  wipePersonalTomb();
  configureHost(createTestHost());
});

describe("Chrome's Local Network Access gate", () => {
  it("waits on a person, never raises the prompt by itself", async () => {
    access = "prompt";
    // Pairing is a person's own action: it may raise the prompt, and waits.
    expect(await pairTailnetDrive(CODE)).toBe("paired");
    expect(reached).toEqual([PROMPT_WAIT_MS]);
    const pushed = drive.writes;

    // A change made afterwards would sync by itself — but not past a prompt.
    await vaultStore.saveItem(createItem("note", "made later"));
    await settle();
    expect(tailnetSyncState()).toMatchObject({
      phase: "blocked",
      error: NETWORK_PROMPT,
    });
    expect(drive.writes).toBe(pushed);
    expect(reached).toEqual([PROMPT_WAIT_MS]);

    // Sync now is the person asking: the prompt may come up, and it lands.
    await syncTailnetNow({ interactive: true });
    expect(reached).toEqual([PROMPT_WAIT_MS, PROMPT_WAIT_MS]);
    expect(drive.writes).toBe(pushed + 1);
    expect(tailnetSyncState().phase).toBe("idle");
  });

  it("sends nothing once the person refused, and says where to allow it", async () => {
    access = "denied";
    await expect(pairTailnetDrive(CODE)).rejects.toThrow(NETWORK_DENIED);
    expect(drive.writes).toBe(0);
    expect(reached).toEqual([]);
  });

  it("says the browser is still asking when the prompt was left unanswered", async () => {
    access = "prompt";
    tailnetSyncSeams.reach = async () => {
      throw new DOMException("Timed out after 120000ms", "TimeoutError");
    };
    await expect(pairTailnetDrive(CODE)).rejects.toThrow(NETWORK_STILL_ASKING);
    expect(drive.writes).toBe(0);
  });

  it("syncs by itself once allowed, with no wait", async () => {
    await pairTailnetDrive(CODE);
    const pushed = drive.writes;
    await vaultStore.saveItem(createItem("note", "made later"));
    await settle();
    expect(drive.writes).toBe(pushed + 1);
    expect(reached).toEqual([]);
    expect(tailnetSyncState().phase).toBe("idle");
  });
});

describe("catching up", () => {
  it("syncs when the app is looked at again and when the device is back online", async () => {
    await pairTailnetDrive(CODE);
    const read = vi.spyOn(drive, "read");
    await settle();
    read.mockClear();

    visibility = "hidden";
    for (const listener of onVisible) listener();
    await settle();
    expect(read).not.toHaveBeenCalled();

    visibility = "visible";
    for (const listener of onVisible) listener();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    for (const listener of onOnline) listener(false);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    for (const listener of onOnline) listener(true);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops listening when sync stops", async () => {
    expect(onVisible.size).toBe(1);
    expect(onOnline.size).toBe(1);
    stopTailnetSync();
    expect(onVisible.size).toBe(0);
    expect(onOnline.size).toBe(0);
  });
});

describe("pairing with a project vault this device does not hold", () => {
  const PROJECT = "prj_4f2a0c1e-9b7d-4e21-8a3c-5d6e7f809a1b";
  const originalProjects = { ...projectSeams };
  const originalVaults = { ...vaultsSeams };

  afterEach(async () => {
    Object.assign(projectSeams, originalProjects);
    Object.assign(vaultsSeams, originalVaults);
    for (const path of [HEADER_PATH, BODY_PATH, INDEX_PATH])
      kvDelete(tombFileKey(PROJECT, path));
    await unregisterTomb(PROJECT);
  });

  it("sets it up beside the open vault and switches to it", async () => {
    // Another device's project vault, as the drive holds it.
    const elsewhere = new VaultStore();
    Object.assign(projectSeams, {
      activeProject: (): PagesProject => ({
        id: PROJECT,
        name: PROJECT,
        kind: "standard",
        createdAt: "2026-09-01T00:00:00.000Z",
      }),
    });
    elsewhere.loadActiveProjectScope();
    await elsewhere.create(PASSWORD);
    drive.snapshot = buildDriveSnapshot(await elsewhere.sealedSnapshot());
    drive.generation = 1;
    elsewhere.lock();
    await vfsFlush();
    for (const path of [HEADER_PATH, BODY_PATH, INDEX_PATH])
      kvDelete(tombFileKey(PROJECT, path));
    await unregisterTomb(PROJECT);
    Object.assign(projectSeams, originalProjects);

    const switched: string[] = [];
    vaultsSeams.switchVault = async (id) => {
      switched.push(id);
      return "locked";
    };
    expect(vaultStore.activeTomb()).toBe(PERSONAL_TOMB);
    expect(await pairTailnetDrive(CODE)).toBe("adopted");
    expect(switched).toEqual([PROJECT]);
    expect(listTombs()).toContain(PROJECT);
    expect(readPlaintextFile(PROJECT, HEADER_PATH)).not.toBeNull();
    // Nothing was written to the drive, and the open vault is untouched.
    expect(drive.writes).toBe(0);
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
  });
});
