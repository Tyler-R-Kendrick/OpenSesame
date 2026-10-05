import {
  dropPack,
  importPackText,
  isPackLoaded,
  packEntries,
} from "@opensesame/vault-item-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete, kvSet } from "../kv.js";
import { clearNotices } from "../notices.js";
import { packSeams } from "./installer.js";
import { PACKS_KEY, readStoredPacks } from "./persist.js";
import { restorePacks } from "./restore.js";
import {
  getPackSnapshot,
  isPackOn,
  resetPackStateForTests,
  statusOf,
} from "./state.js";

const sha = (id: string) =>
  packEntries().find((entry) => entry.id === id)?.sha256 ?? "";

beforeEach(() => {
  for (const entry of packEntries()) dropPack(entry.id);
  resetPackStateForTests();
  kvDelete(PACKS_KEY);
  clearNotices();
});

describe("restoring packs at boot", () => {
  it("registers a stored pack from its copy with no request", async () => {
    const fetchText = vi.fn(importPackText);
    packSeams.fetchText = fetchText;
    kvSet(
      PACKS_KEY,
      JSON.stringify({
        v: 1,
        packs: {
          wifi: { sha256: sha("wifi"), text: await importPackText("wifi") },
        },
      }),
    );
    await restorePacks();
    expect(isPackLoaded("wifi")).toBe(true);
    expect(isPackOn("wifi")).toBe(true);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("refetches a copy whose digest is not the build's", async () => {
    packSeams.fetchText = importPackText;
    kvSet(
      PACKS_KEY,
      JSON.stringify({
        v: 1,
        packs: { wifi: { sha256: "0".repeat(64), text: "old" } },
      }),
    );
    await restorePacks();
    await vi.waitFor(() => expect(statusOf("wifi").phase).toBe("on"));
    expect(readStoredPacks().get("wifi")?.sha256).toBe(sha("wifi"));
  });

  it("reports a stored copy that has been tampered with, loads nothing", async () => {
    kvSet(
      PACKS_KEY,
      JSON.stringify({
        v: 1,
        packs: { wifi: { sha256: sha("wifi"), text: "{}" } },
      }),
    );
    await restorePacks();
    expect(isPackLoaded("wifi")).toBe(false);
    expect(statusOf("wifi").phase).toBe("failed");
    expect(getPackSnapshot().settled).toBe(0);
  });

  it("forgets a pack this build no longer has", async () => {
    kvSet(
      PACKS_KEY,
      JSON.stringify({ v: 1, packs: { retired: { sha256: "a", text: "{}" } } }),
    );
    await restorePacks();
    expect(readStoredPacks().get("retired")).toBeUndefined();
  });

  it("starts with nothing on a device that has never switched one on", async () => {
    await restorePacks();
    expect(getPackSnapshot().pending).toBe(0);
    expect(Object.keys(getPackSnapshot().status)).toEqual([]);
  });
});
