/**
 * What receipts do when they cannot be written or read (ADR 0162): a receipt
 * that could not be written is held and written in the order it was decided,
 * what has been written is not counted as waiting, a trail this build cannot
 * read is replaced by one that begins with a marker, and what waits is bounded.
 */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  flushReceipts,
  listReceipts,
  pendingReceipts,
  recordReceipt,
  resetHeldReceiptsForTest,
} from "./device-receipts.js";
import {
  lockAllTombs,
  readFile,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeFile,
} from "./vfs.js";

const APP = "local_11111111-1111-4111-8111-111111111111";
const TRAIL = "config/device-receipts";
const PENDING = "config/device-receipts-pending";
let tomb: string;

const bytes = (text: string) => new TextEncoder().encode(text);

/** The clock at second `at` of a fixed minute, so the order of decisions is known. */
const clock = (at: number) =>
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 4, 10, 0, at)));

/** A receipt as the file holds it, decided at second `at`. */
const stored = (
  id: string,
  at: number,
  eventType = "access.request.created",
) => ({
  id,
  occurredAt: new Date(Date.UTC(2026, 9, 4, 10, 0, at)).toISOString(),
  eventType,
  outcome: "succeeded",
  targetType: "application",
  targetId: APP,
  metadata: {},
});

const fileOf = (...receipts: object[]) =>
  bytes(JSON.stringify({ version: 1, receipts }));

/** Writes to the files named refuse, as a full disk would, until `mend`. */
function refuseWrites(...paths: string[]) {
  const real = vfsSeams.writeRaw;
  const refused = new Set(paths.map((path) => tombFileKey(tomb, path)));
  return vi
    .spyOn(vfsSeams, "writeRaw")
    .mockImplementation((key, value) =>
      refused.has(key)
        ? Promise.reject(new Error("disk full"))
        : real(key, value),
    );
}

const typesOf = async () =>
  (await listReceipts(tomb, 20)).map((row) => row.eventType);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(0);
  tomb = `receipts-failure-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});

afterEach(() => {
  resetHeldReceiptsForTest();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a receipt that could not be written", () => {
  it("is held, counted, and never fails the decision", async () => {
    refuseWrites(TRAIL);
    await expect(
      recordReceipt(tomb, "request.approved", { applicationId: APP }),
    ).resolves.toBeUndefined();
    expect(await pendingReceipts(tomb)).toBe(1);
  });

  it("is written once the trail can take it, in the order it was decided", async () => {
    const refusing = refuseWrites(TRAIL);
    clock(1);
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    clock(2);
    await recordReceipt(tomb, "request.approved", { applicationId: APP });
    expect(await pendingReceipts(tomb)).toBe(2);
    refusing.mockRestore();
    expect(await flushReceipts(tomb)).toBe(0);
    expect(await typesOf()).toEqual([
      "access.request.approved",
      "access.request.created",
    ]);
  });

  it("survives a reload of the tab, and is written where its time puts it", async () => {
    const refusing = refuseWrites(TRAIL);
    clock(1);
    await recordReceipt(tomb, "request.denied", { applicationId: APP });
    resetHeldReceiptsForTest();
    expect(await pendingReceipts(tomb)).toBe(1);
    refusing.mockRestore();
    clock(2);
    // The next decision writes the one that waited, behind itself: it was
    // decided first.
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    expect(await typesOf()).toEqual([
      "access.request.created",
      "access.request.denied",
    ]);
    expect(await pendingReceipts(tomb)).toBe(0);
  });

  it("is written once however many times the trail is read", async () => {
    const refusing = refuseWrites(TRAIL);
    await recordReceipt(tomb, "request.denied", { applicationId: APP });
    refusing.mockRestore();
    await flushReceipts(tomb);
    await flushReceipts(tomb);
    expect(await listReceipts(tomb, 10)).toHaveLength(1);
  });

  it("does not wait in memory for a vault that is shut", async () => {
    refuseWrites(TRAIL);
    lockAllTombs();
    await recordReceipt(tomb, "request.denied", { applicationId: APP });
    expect(await pendingReceipts(tomb)).toBe(0);
  });

  it("is held no more than the trail itself could hold", async () => {
    refuseWrites(TRAIL, PENDING);
    for (let each = 0; each < 300; each += 1) {
      clock(each % 50);
      await recordReceipt(tomb, "request.created", { applicationId: APP });
    }
    expect(await pendingReceipts(tomb)).toBe(256);
  });
});

describe("the order of what is written", () => {
  it("puts a receipt that waited behind one written after it was decided", async () => {
    // Another tab wrote the third second's receipt; this one's was left in the
    // pending list from the first, by a tab that closed.
    await writeFile(tomb, TRAIL, fileOf(stored("newer", 3)));
    await writeFile(tomb, PENDING, fileOf(stored("older", 1)));
    expect(await flushReceipts(tomb)).toBe(0);
    expect((await listReceipts(tomb, 10)).map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("does not count a receipt already in the trail as waiting", async () => {
    // Written to the trail, then the tab closed before the list was cleared.
    await writeFile(tomb, TRAIL, fileOf(stored("done", 1)));
    await writeFile(tomb, PENDING, fileOf(stored("done", 1)));
    expect(await pendingReceipts(tomb)).toBe(0);
    await flushReceipts(tomb);
    expect(await listReceipts(tomb, 10)).toHaveLength(1);
    expect(
      JSON.parse(new TextDecoder().decode(await readFile(tomb, PENDING))),
    ).toMatchObject({ receipts: [] });
  });
});

describe("a trail this build cannot read", () => {
  it("is replaced, by one that begins with a marker, so the next receipt is written", async () => {
    await writeFile(tomb, TRAIL, bytes('{"version":2,"receipts":"?"}'));
    clock(1);
    await recordReceipt(tomb, "request.denied", { applicationId: APP });
    expect(await pendingReceipts(tomb)).toBe(0);
    expect((await typesOf()).sort()).toEqual([
      "access.receipts.reset",
      "access.request.denied",
    ]);
  });

  it("is replaced by a read alone, with nothing waiting to be written", async () => {
    await writeFile(tomb, TRAIL, bytes("not json"));
    expect(await typesOf()).toEqual(["access.receipts.reset"]);
    // And once: the replacement is itself a trail that reads.
    expect(await typesOf()).toEqual(["access.receipts.reset"]);
  });

  it("is replaced when its ciphertext does not open under this vault's key", async () => {
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    await vfsSeams.writeRaw(tombFileKey(tomb, TRAIL), '{"v":1,"not":"sealed"}');
    expect(await typesOf()).toEqual(["access.receipts.reset"]);
  });

  it("is replaced when it was sealed under a key this vault no longer has", async () => {
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    lockAllTombs();
    // A vault made afterwards in the same tomb has another key.
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    expect(await typesOf()).toEqual(["access.receipts.reset"]);
  });

  it("is not replaced for being out of reach: a locked vault keeps what it has", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(tomb, vaultKey);
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    lockAllTombs();
    await expect(listReceipts(tomb, 10)).rejects.toThrow();
    expect(await flushReceipts(tomb)).toBe(0);
    // The same vault, opened again, still has its trail and no marker.
    unlockTomb(tomb, vaultKey);
    expect(await typesOf()).toEqual(["access.request.created"]);
  });
});
