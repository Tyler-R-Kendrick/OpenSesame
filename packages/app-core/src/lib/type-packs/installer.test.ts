import {
  dropPack,
  importPackText,
  isPackLoaded,
  packEntries,
} from "@opensesame/vault-item-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete } from "../kv.js";
import { clearNotices, listNotices } from "../notices.js";
import {
  disablePack,
  enablePack,
  enablePacks,
  packSeams,
} from "./installer.js";
import { PACKS_KEY, readStoredPacks } from "./persist.js";
import {
  getPackSnapshot,
  isPackOn,
  resetPackStateForTests,
  setCounts,
  statusOf,
  subscribePackState,
} from "./state.js";

const original = { ...packSeams };

/** Resolves once the queue is quiet. */
async function idle(): Promise<void> {
  await vi.waitFor(() => expect(getPackSnapshot().pending).toBe(0));
}

beforeEach(() => {
  for (const entry of packEntries()) dropPack(entry.id);
  resetPackStateForTests();
  kvDelete(PACKS_KEY);
  clearNotices();
});

afterEach(() => {
  Object.assign(packSeams, original);
  vi.useRealTimers();
});

describe("switching a pack on", () => {
  it("walks queued → downloading → installing → on and registers the type", async () => {
    const phases: string[] = [];
    const stop = subscribePackState(() =>
      phases.push(statusOf("address").phase),
    );
    enablePack("address");
    await idle();
    stop();
    // The run resetting its counter re-announces the last phase; collapse it.
    const walked = phases.filter((phase, at) => phase !== phases[at - 1]);
    expect(walked).toEqual(["queued", "downloading", "installing", "on"]);
    expect(isPackLoaded("address")).toBe(true);
    expect(isPackOn("address")).toBe(true);
  });

  it("keeps a sealed copy so the next boot needs no request", async () => {
    enablePack("note");
    await idle();
    const stored = readStoredPacks().get("note");
    expect(stored?.sha256).toBe(
      packEntries().find((entry) => entry.id === "note")?.sha256,
    );
    expect(stored?.text).toBe(await importPackText("note"));
  });

  it("hands the main thread back at every step, and between packs", async () => {
    const yielded = vi.fn(() => Promise.resolve());
    packSeams.yieldToMain = yielded;
    enablePacks(["address", "card", "note"]);
    await idle();
    // Before the download, before the install and after each pack: at least
    // three times per pack, so eighteen definitions never form one long task.
    expect(yielded.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("installs one pack at a time, however many are on their way", async () => {
    const seen: number[] = [];
    const sample = () =>
      packEntries().filter((entry) => statusOf(entry.id).phase === "installing")
        .length;
    const stop = subscribePackState(() => seen.push(sample()));
    enablePacks(["address", "card", "note"]);
    await idle();
    stop();
    expect(Math.max(...seen)).toBe(1);
    expect(["address", "card", "note"].every((id) => isPackOn(id))).toBe(true);
  });

  it("downloads a few ahead, so a bulk switch takes the slowest chunk and not the sum", async () => {
    const releases = new Map<string, () => void>();
    packSeams.fetchText = (id) =>
      new Promise((resolve) => {
        releases.set(id, () => resolve(importPackText(id)));
      });
    enablePacks(["address", "card", "note"]);
    // All three are in the air before any has landed.
    await vi.waitFor(() => expect(releases.size).toBe(3));
    for (const release of releases.values()) release();
    await idle();
    expect(["address", "card", "note"].every((id) => isPackOn(id))).toBe(true);
  });

  it("answers the first press only: a second while busy is ignored", async () => {
    const fetchText = vi.fn(importPackText);
    packSeams.fetchText = fetchText;
    enablePack("wifi");
    enablePack("wifi");
    await idle();
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});

describe("a pack that does not arrive", () => {
  it("fails with the reason, keeps nothing, and notices it with a retry", async () => {
    packSeams.fetchText = () =>
      Promise.reject(new Error("The address pack could not be downloaded."));
    enablePack("address");
    await idle();
    expect(statusOf("address")).toEqual({
      phase: "failed",
      reason: "The address pack could not be downloaded.",
    });
    expect(isPackLoaded("address")).toBe(false);
    expect(readStoredPacks().get("address")).toBeUndefined();
    const notice = listNotices().find((n) => n.id === "type-pack:address");
    expect(notice?.tone).toBe("err");
    expect(notice?.retry).toBeTypeOf("function");

    packSeams.fetchText = importPackText;
    notice?.retry?.();
    await idle();
    expect(statusOf("address").phase).toBe("on");
    expect(listNotices().some((n) => n.id === "type-pack:address")).toBe(false);
  });

  it("refuses text that is not the build's own", async () => {
    packSeams.fetchText = async (id) =>
      (await importPackText(id)).replace('"1.0.0"', '"9.9.9"');
    enablePack("address");
    await idle();
    expect(statusOf("address").phase).toBe("failed");
    expect(statusOf("address").reason).toMatch(/not the one this build/);
    expect(isPackLoaded("address")).toBe(false);
  });

  it("does not mistake an unknown id for a pack", () => {
    enablePack("not-a-type");
    expect(getPackSnapshot().pending).toBe(0);
    expect(statusOf("not-a-type").phase).toBe("off");
  });
});

describe("switching a pack off", () => {
  it("cancels a pack still on its way, and installs nothing", async () => {
    let release: () => void = () => undefined;
    packSeams.fetchText = (id) =>
      new Promise((resolve) => {
        release = () => resolve(importPackText(id));
      });
    enablePack("address");
    await vi.waitFor(() =>
      expect(statusOf("address").phase).toBe("downloading"),
    );
    await disablePack("address");
    expect(statusOf("address").phase).toBe("off");
    release();
    await idle();
    expect(isPackLoaded("address")).toBe(false);
    expect(readStoredPacks().get("address")).toBeUndefined();
  });

  it("drops an installed pack and forgets its copy", async () => {
    enablePack("card");
    await idle();
    expect(await disablePack("card")).toEqual({ ok: true });
    expect(isPackLoaded("card")).toBe(false);
    expect(readStoredPacks().get("card")).toBeUndefined();
    expect(statusOf("card").phase).toBe("off");
  });

  it("keeps a type the open vault holds items of, and says how many", async () => {
    enablePack("card");
    await idle();
    setCounts(new Map([["card", 3]]));
    expect(await disablePack("card")).toEqual({
      ok: false,
      reason: "Card has 3 items in this vault.",
    });
    expect(isPackLoaded("card")).toBe(true);
    setCounts(new Map([["card", 1]]));
    expect(await disablePack("card")).toMatchObject({
      reason: "Card has 1 item in this vault.",
    });
  });
});

describe("the tray", () => {
  it("follows a bulk switch with one notice, then clears itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    packSeams.yieldToMain = () => Promise.resolve();
    enablePacks(["address", "card"]);
    expect(listNotices().filter((n) => n.id === "type-packs")).toHaveLength(1);
    await vi.waitFor(() => expect(getPackSnapshot().pending).toBe(0));
    const done = listNotices().find((n) => n.id === "type-packs");
    expect(done?.title).toBe("2 item types installed");
    vi.advanceTimersByTime(6000);
    expect(listNotices().some((n) => n.id === "type-packs")).toBe(false);
  });
});

describe("a pack that needs another (ADR 0179)", () => {
  it("switches Password on with Accounts, and keeps it on while Accounts is", async () => {
    enablePack("account");
    await vi.waitFor(() => expect(isPackOn("account")).toBe(true));
    await vi.waitFor(() => expect(isPackOn("password")).toBe(true));
    expect(await disablePack("password")).toEqual({
      ok: false,
      reason: "Account needs Password.",
    });
    expect(isPackOn("password")).toBe(true);
    expect(await disablePack("account")).toEqual({ ok: true });
    expect(await disablePack("password")).toEqual({ ok: true });
    expect(isPackOn("password")).toBe(false);
  });
});
