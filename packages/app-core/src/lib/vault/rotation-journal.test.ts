import { mintVaultKey, sealJson } from "@opensesame/vault-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_PATH, tombFileKey, vfsSeams } from "../vfs.js";
import {
  ROTATION_JOURNAL_MAX_BYTES,
  ROTATION_JOURNAL_PATH,
  commitRotationJournal,
  hasPendingRotationJournal,
  prepareRotationJournal,
  recoverRotationJournal,
} from "./rotation-journal.js";

async function fixture() {
  const tomb = "rotation-journal-test";
  const { vaultKey } = await mintVaultKey();
  const seal = JSON.stringify(await sealJson(vaultKey, { synthetic: true }));
  const input = {
    tomb,
    token: "revision-2",
    previousHeader: '{"revision":1}',
    nextHeader: '{"revision":2}',
    files: { body: seal, index: seal, "config/prefs": seal },
  };
  const disk = new Map<string, string>([
    [tombFileKey(tomb, HEADER_PATH), input.previousHeader],
  ]);
  const effects: string[] = [];
  vi.spyOn(vfsSeams, "readRaw").mockImplementation(
    (key) => disk.get(key) ?? null,
  );
  vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
    effects.push(key);
    disk.set(key, value);
  });
  vi.spyOn(vfsSeams, "deleteRaw").mockImplementation(async (key) => {
    effects.push(`delete:${key}`);
    disk.delete(key);
  });
  return {
    tomb,
    input,
    disk,
    effects,
    serialized: prepareRotationJournal(input),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("ciphertext-only rotation recovery", () => {
  it("retains the previous header on interrupted file publication and rolls forward after restart", async () => {
    const f = await fixture();
    const original = async (key: string, value: string) => {
      f.effects.push(key);
      f.disk.set(key, value);
    };
    let fail = true;
    vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
      if (fail && key === tombFileKey(f.tomb, "index")) {
        fail = false;
        throw new Error("simulated disk interruption");
      }
      await original(key, value);
    });
    await expect(
      commitRotationJournal(f.tomb, f.serialized, () => {}),
    ).rejects.toThrow("interruption");
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.previousHeader,
    );
    expect(hasPendingRotationJournal(f.tomb)).toBe(true);
    await expect(recoverRotationJournal(f.tomb, () => {})).resolves.toBe(true);
    for (const [path, raw] of Object.entries(f.input.files))
      expect(f.disk.get(tombFileKey(f.tomb, path))).toBe(raw);
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.nextHeader,
    );
    expect(f.effects.slice(-2)).toEqual([
      tombFileKey(f.tomb, HEADER_PATH),
      `delete:${tombFileKey(f.tomb, ROTATION_JOURNAL_PATH)}`,
    ]);
    expect(hasPendingRotationJournal(f.tomb)).toBe(false);
  });
  it("does not publish any live ciphertext when durable journal preparation fails", async () => {
    const f = await fixture();
    vi.spyOn(vfsSeams, "writeRaw").mockRejectedValueOnce(
      new Error("journal preparation failed"),
    );
    await expect(
      commitRotationJournal(f.tomb, f.serialized, () => {}),
    ).rejects.toThrow("journal preparation failed");
    expect(f.effects).toEqual([]);
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.previousHeader,
    );
    expect(hasPendingRotationJournal(f.tomb)).toBe(false);
  });
  it("recovers a committed header whose journal deletion failed", async () => {
    const f = await fixture();
    vi.spyOn(vfsSeams, "deleteRaw").mockRejectedValueOnce(
      new Error("delete interruption"),
    );
    await expect(
      commitRotationJournal(f.tomb, f.serialized, () => {}),
    ).rejects.toThrow("delete interruption");
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.nextHeader,
    );
    await expect(recoverRotationJournal(f.tomb, () => {})).resolves.toBe(true);
    expect(hasPendingRotationJournal(f.tomb)).toBe(false);
  });
  it("never replays an old journal over a successor header", async () => {
    const f = await fixture();
    f.disk.set(tombFileKey(f.tomb, ROTATION_JOURNAL_PATH), f.serialized);
    f.disk.set(tombFileKey(f.tomb, HEADER_PATH), '{"revision":3}');
    await expect(recoverRotationJournal(f.tomb, () => {})).rejects.toThrow(
      "current header",
    );
    expect(f.effects).toEqual([]);
  });
  it("leaves pending ciphertext on realm cancellation without publishing the header", async () => {
    const f = await fixture();
    let cancelled = false;
    const original = async (key: string, value: string) => {
      f.effects.push(key);
      f.disk.set(key, value);
    };
    vi.spyOn(vfsSeams, "writeRaw").mockImplementation(async (key, value) => {
      await original(key, value);
      if (key.endsWith("/body")) cancelled = true;
    });
    await expect(
      commitRotationJournal(f.tomb, f.serialized, () => {
        if (cancelled) throw new Error("realm cancelled");
      }),
    ).rejects.toThrow("realm cancelled");
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.previousHeader,
    );
    expect(hasPendingRotationJournal(f.tomb)).toBe(true);
    await recoverRotationJournal(f.tomb, () => {});
    expect(f.disk.get(tombFileKey(f.tomb, HEADER_PATH))).toBe(
      f.input.nextHeader,
    );
  });
  it("rejects a serialized journal over the finite byte budget before any write", async () => {
    const f = await fixture();
    expect(() =>
      prepareRotationJournal({
        ...f.input,
        nextHeader: JSON.stringify({
          hint: "a".repeat(ROTATION_JOURNAL_MAX_BYTES),
        }),
      }),
    ).toThrow("Invalid vault rotation journal");
    expect(f.effects).toEqual([]);
  });
  it("rejects plaintext, reserved paths, wrong tomb and excessive path counts before writes", async () => {
    const f = await fixture();
    expect(() =>
      prepareRotationJournal({
        ...f.input,
        files: { ...f.input.files, body: '{"password":"fixture-secret"}' },
      }),
    ).toThrow();
    expect(() =>
      prepareRotationJournal({
        ...f.input,
        files: { ...f.input.files, header: f.input.nextHeader },
      }),
    ).toThrow();
    const tooMany = Object.fromEntries(
      Array.from({ length: 1025 }, (_, i) => [
        `files/f${i}`,
        f.input.files.body,
      ]),
    );
    expect(() =>
      prepareRotationJournal({
        ...f.input,
        files: {
          ...tooMany,
          body: f.input.files.body,
          index: f.input.files.index,
        },
      }),
    ).toThrow();
    await expect(
      commitRotationJournal("unrelated", f.serialized, () => {}),
    ).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
});
