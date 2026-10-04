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
    const stop = (await import("./state.js")).subscribePackState(() =>
      phases.push(statusOf("login").phase),
    );
    enablePack("login");
    await idle();
    stop();
    // The run resetting its counter re-announces the last phase; collapse it.
    const walked = phases.filter((phase, at) => phase !== phases[at - 1]);
    expect(walked).toEqual(["queued", "downloading", "installing", "on"]);
    expect(isPackLoaded("login")).toBe(true);
    expect(isPackOn("login")).toBe(true);
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
    enablePacks(["login", "card", "note"]);
    await idle();
    // Before the download, before the install and after each pack: at least
    // three times per pack, so eighteen definitions never form one long task.
    expect(yielded.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("runs one pack at a time", async () => {
    const seen: number[] = [];
    packSeams.fetchText = async (id) => {
      const busy = packEntries().filter(
        (entry) => statusOf(entry.id).phase === "downloading",
      ).length;
      seen.push(busy);
      return importPackText(id);
    };
    enablePacks(["login", "card", "note"]);
    await idle();
    expect(seen).toEqual([1, 1, 1]);
    expect(["login", "card", "note"].every((id) => isPackOn(id))).toBe(true);
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
      Promise.reject(new Error("The login pack could not be downloaded."));
    enablePack("login");
    await idle();
    expect(statusOf("login")).toEqual({
      phase: "failed",
      reason: "The login pack could not be downloaded.",
    });
    expect(isPackLoaded("login")).toBe(false);
    expect(readStoredPacks().get("login")).toBeUndefined();
    const notice = listNotices().find((n) => n.id === "type-pack:login");
    expect(notice?.tone).toBe("err");
    expect(notice?.retry).toBeTypeOf("function");

    packSeams.fetchText = importPackText;
    notice?.retry?.();
    await idle();
    expect(statusOf("login").phase).toBe("on");
    expect(listNotices().some((n) => n.id === "type-pack:login")).toBe(false);
  });

  it("refuses text that is not the build's own", async () => {
    packSeams.fetchText = async (id) =>
      (await importPackText(id)).replace('"1.0.0"', '"9.9.9"');
    enablePack("login");
    await idle();
    expect(statusOf("login").phase).toBe("failed");
    expect(statusOf("login").reason).toMatch(/not the one this build/);
    expect(isPackLoaded("login")).toBe(false);
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
    enablePack("login");
    await vi.waitFor(() => expect(statusOf("login").phase).toBe("downloading"));
    await disablePack("login");
    expect(statusOf("login").phase).toBe("off");
    release();
    await idle();
    expect(isPackLoaded("login")).toBe(false);
    expect(readStoredPacks().get("login")).toBeUndefined();
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
    enablePacks(["login", "card"]);
    expect(listNotices().filter((n) => n.id === "type-packs")).toHaveLength(1);
    await vi.waitFor(() => expect(getPackSnapshot().pending).toBe(0));
    const done = listNotices().find((n) => n.id === "type-packs");
    expect(done?.title).toBe("2 item types installed");
    vi.advanceTimersByTime(6000);
    expect(listNotices().some((n) => n.id === "type-packs")).toBe(false);
  });
});
