import { createItem } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { kvDelete } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readPlaintextFile,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { adoptSnapshot } from "./adopt.js";
import { PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";
import {
  formatPairingCode,
  isTailnetOrLoopback,
  parsePairingCode,
} from "./pairing.js";
import { buildDriveSnapshot, parseDriveSnapshot } from "./snapshot.js";

const PASSWORD = "correct horse battery staple";

function wipePersonalTomb(): void {
  for (const path of [
    HEADER_PATH,
    BODY_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
}

async function vaultWith(...names: string[]): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  for (const name of names) await store.saveItem(createItem("note", name));
  return store;
}

const names = (store: VaultStore) =>
  store
    .getSnapshot()
    .items.map((item) => item.name)
    .sort();

beforeEach(async () => {
  await vfsFlush();
  wipePersonalTomb();
});

describe("pairing codes", () => {
  it("round-trips a tailnet drive", () => {
    expect(parsePairingCode(formatPairingCode(PAIRING))).toEqual(PAIRING);
  });

  it("refuses a drive on the open internet", () => {
    const code = formatPairingCode({ ...PAIRING, url: "https://evil.example" });
    expect(parsePairingCode(code)).toBeNull();
  });

  it("refuses plain http to anything but the tailnet or this machine", () => {
    const code = formatPairingCode({
      ...PAIRING,
      url: "http://10.0.0.5:18790",
    });
    expect(parsePairingCode(code)).toBeNull();
  });

  it("accepts MagicDNS names, CGNAT addresses and loopback", () => {
    expect(isTailnetOrLoopback("http://desk:18790")).toBe(true);
    expect(isTailnetOrLoopback("http://100.101.102.103:18790")).toBe(true);
    expect(isTailnetOrLoopback("http://127.0.0.1:18790")).toBe(true);
    expect(isTailnetOrLoopback("https://desk.example.com")).toBe(false);
  });

  it("refuses a short key and anything that is not a code", () => {
    expect(
      parsePairingCode(formatPairingCode({ ...PAIRING, key: "x" })),
    ).toBeNull();
    expect(parsePairingCode("hello")).toBeNull();
    expect(parsePairingCode("opensesame-drive:v1:!!!")).toBeNull();
  });
});

describe("drive snapshots", () => {
  it("never carry the PIN wrap or the hint off the device", async () => {
    const store = await vaultWith("a");
    await store.enrollPin("48291573");
    const sealed = await store.sealedSnapshot();
    expect(sealed.header.unlocks?.pin).toBeDefined();
    const snapshot = buildDriveSnapshot({
      ...sealed,
      header: { ...sealed.header, hint: "the usual" },
    });
    expect(snapshot.header.unlocks?.pin).toBeUndefined();
    expect(snapshot.header.hint).toBeUndefined();
    expect(snapshot.header.wrap).toEqual(sealed.header.wrap);
    expect(parseDriveSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
  });

  it("refuses anything that is not one", () => {
    expect(() => parseDriveSnapshot({ format: "x" })).toThrow();
    expect(() => parseDriveSnapshot(null)).toThrow();
  });
});

describe("syncOnce", () => {
  it("fills an empty drive, then has nothing to do", async () => {
    const store = await vaultWith("a");
    const drive = memoryDrive();
    expect(await syncOnce(store, PAIRING, drive)).toEqual({
      pulled: false,
      pushed: true,
      generation: 1,
    });
    expect(await syncOnce(store, PAIRING, drive)).toEqual({
      pulled: false,
      pushed: false,
      generation: 1,
    });
    expect(drive.writes).toBe(1);
  });

  it("pushes a local edit", async () => {
    const store = await vaultWith("a");
    const drive = memoryDrive();
    await syncOnce(store, PAIRING, drive);
    await store.saveItem(createItem("note", "b"));
    const outcome = await syncOnce(store, PAIRING, drive);
    expect(outcome.pushed).toBe(true);
    expect(drive.snapshot?.rev).toBe((await store.sealedSnapshot()).rev);
  });

  it("starts again when another device writes first, and loses nothing", async () => {
    const store = await vaultWith("a");
    const drive = memoryDrive();
    await syncOnce(store, PAIRING, drive);
    const stale = drive.snapshot;
    await store.saveItem(createItem("note", "b"));
    drive.beforeWrite = () => {
      drive.generation += 1;
      drive.snapshot = stale;
    };
    const outcome = await syncOnce(store, PAIRING, drive);
    expect(outcome).toMatchObject({ pushed: true, generation: 3 });
    expect(names(store)).toEqual(["a", "b"]);
  });

  it("refuses to overwrite a drive holding another vault", async () => {
    const other = await vaultWith("theirs");
    const drive = memoryDrive();
    await syncOnce(other, PAIRING, drive);
    await vfsFlush();
    wipePersonalTomb();
    const mine = await vaultWith("mine");
    await expect(syncOnce(mine, PAIRING, drive)).rejects.toThrow(
      /another vault/,
    );
    expect(drive.writes).toBe(1);
  });
});

describe("setting up a second device from the drive", () => {
  it("adopts the vault, opens it with the master password, and syncs back", async () => {
    const first = await vaultWith("a", "b");
    await first.enrollPin("48291573");
    const drive = memoryDrive();
    await syncOnce(first, PAIRING, drive);
    const snapshot = drive.snapshot;
    if (!snapshot) throw new Error("expected a snapshot on the drive");

    // The second device starts with nothing.
    first.lock();
    await vfsFlush();
    wipePersonalTomb();

    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    const header = JSON.parse(
      readPlaintextFile(PERSONAL_TOMB, HEADER_PATH) ?? "{}",
    );
    expect(header.unlocks?.pin).toBeUndefined();

    const second = new VaultStore();
    second.rehydrate();
    await second.unlock(PASSWORD);
    expect(names(second)).toEqual(["a", "b"]);

    await second.saveItem(createItem("note", "c"));
    expect((await syncOnce(second, PAIRING, drive)).pushed).toBe(true);
    expect(await adoptSnapshot(snapshot)).toBe("already-here");
  });

  it("will not adopt over a different vault", async () => {
    const theirs = await vaultWith("theirs");
    const drive = memoryDrive();
    await syncOnce(theirs, PAIRING, drive);
    const snapshot = drive.snapshot;
    if (!snapshot) throw new Error("expected a snapshot on the drive");
    theirs.lock();
    await vfsFlush();
    wipePersonalTomb();
    await vaultWith("mine");
    await expect(adoptSnapshot(snapshot)).rejects.toThrow(/different vault/);
  });

  it("will not adopt a vault that only a PIN opens", async () => {
    const store = await vaultWith("a");
    const sealed = await store.sealedSnapshot();
    const snapshot = buildDriveSnapshot({
      ...sealed,
      header: { v: 1, createdAt: sealed.header.createdAt },
    });
    store.lock();
    await vfsFlush();
    wipePersonalTomb();
    await expect(adoptSnapshot(snapshot)).rejects.toThrow(/PIN/);
  });
});
