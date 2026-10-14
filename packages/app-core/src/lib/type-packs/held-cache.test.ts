import { type VaultItem, createCredential } from "@opensesame/vault-core";
import {
  dropPack,
  importPackText,
  isPackLoaded,
  packEntry,
} from "@opensesame/vault-item-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installOpfs,
  makeOpfs,
} from "../duress/wipe/fake-opfs.test-support.js";
import { kvDelete, kvFlush, kvForgetAll, kvHydrate, kvSet } from "../kv.js";
import { HELD_PACKS_KEY } from "./held-cache.js";
import { packSeams } from "./installer.js";
import { PACKS_KEY, readStoredPacks } from "./persist.js";
import { restorePacks } from "./restore.js";
import { getPackSnapshot, resetPackStateForTests, statusOf } from "./state.js";
import { watchVaultTypes } from "./watch.js";

const original = { ...packSeams };
const token = () =>
  createCredential(
    {
      id: crypto.randomUUID(),
      type: "token",
      token: "fixture-secret",
      expiresAt: "",
    },
    "Saved connection token",
  );
const stops: (() => void)[] = [];
function watch(items: readonly VaultItem[]) {
  const source = { getSnapshot: () => ({ items }), subscribe: () => () => {} };
  const stop = watchVaultTypes(source);
  stops.push(stop);
  return stop;
}
async function idle() {
  await vi.waitFor(() => expect(getPackSnapshot().pending).toBe(0));
}
function cold() {
  for (const stop of stops.splice(0)) stop();
  dropPack("token");
  resetPackStateForTests();
}
beforeEach(() => {
  cold();
  kvDelete(PACKS_KEY);
  kvDelete(HELD_PACKS_KEY);
  packSeams.fetchText = importPackText;
  packSeams.yieldToMain = () => Promise.resolve();
});
afterEach(() => {
  cold();
  vi.unstubAllGlobals();
  Object.assign(packSeams, original);
});

it("cold restores a held real Token without HTTP or a remembered user choice", async () => {
  const disk = makeOpfs();
  installOpfs(disk);
  const item = token();
  watch([item]);
  await idle();
  expect(isPackLoaded("token")).toBe(true);
  expect(readStoredPacks().has("token")).toBe(false);
  expect(readStoredPacks(HELD_PACKS_KEY).get("token")?.text).toBe(
    await importPackText("token"),
  );
  cold();
  await kvFlush();
  kvForgetAll();
  expect(readStoredPacks(HELD_PACKS_KEY).has("token")).toBe(false);
  await kvHydrate([PACKS_KEY, HELD_PACKS_KEY]);
  expect(
    disk.files.get(`opensesame-pages-${HELD_PACKS_KEY}.json`),
  ).not.toContain(packEntry("token")?.sha256);
  const fetch = vi.fn(async () => {
    throw new Error("Offline");
  });
  packSeams.fetchText = fetch;
  await restorePacks();
  watch([]);
  await idle();
  expect(isPackLoaded("token")).toBe(false);
  watch([item]);
  await idle();
  expect(isPackLoaded("token")).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(readStoredPacks().has("token")).toBe(false);
});

it("rejects cached bytes with the current index digest but invalid content", async () => {
  kvSet(
    HELD_PACKS_KEY,
    JSON.stringify({
      v: 1,
      packs: { token: { sha256: packEntry("token")?.sha256, text: "{}" } },
    }),
  );
  const fetch = vi.fn(importPackText);
  packSeams.fetchText = fetch;
  watch([token()]);
  await idle();
  expect(statusOf("token").phase).toBe("failed");
  expect(isPackLoaded("token")).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("refetches an old-build cache only when an actual held item requires it", async () => {
  kvSet(
    HELD_PACKS_KEY,
    JSON.stringify({
      v: 1,
      packs: { token: { sha256: "0".repeat(64), text: "old" } },
    }),
  );
  const fetch = vi.fn(importPackText);
  packSeams.fetchText = fetch;
  watch([]);
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  watch([token()]);
  await idle();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("token");
  expect(isPackLoaded("token")).toBe(true);
});

it("does not publish a type after its owning vault locks while download is pending", async () => {
  let release = () => {};
  packSeams.fetchText = (id) =>
    new Promise((resolve) => {
      release = () => {
        void importPackText(id).then(resolve);
      };
    });
  const stop = watch([token()]);
  await vi.waitFor(() => expect(statusOf("token").phase).toBe("downloading"));
  stop();
  release();
  await idle();
  expect(isPackLoaded("token")).toBe(false);
  expect(statusOf("token").phase).toBe("off");
  expect(readStoredPacks(HELD_PACKS_KEY).has("token")).toBe(false);
});
