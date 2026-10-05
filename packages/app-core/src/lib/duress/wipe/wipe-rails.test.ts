/**
 * The safety rails around the wipe runner (ADR 0167): it runs only for a plan
 * this build understands, only when nothing forbids the real removal, only
 * through the unlock seam, and never from arming or removing a code.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../../host.js";
import type { PagePort } from "../../../ports.js";
import { createTestHost } from "../../../test-host.js";
import { vaultStore } from "../../vault/store.js";
import { clearJournal } from "../store/journal.js";
import { WIPE_INTENT_KEY } from "../store/boot-keys.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import { duressSessionFence } from "../session/fence.js";
import {
  enableDuressCode,
  removeDuressCode,
} from "../settings/device-duress.js";
import {
  decodePlan,
  encodePlan,
  getMode,
  runDuressEffects,
} from "../settings/modes/index.js";
import { wipeGuard } from "./guard.js";
import { allowRealWipe } from "./test-guard.js";
import { isWipeBody, runWipeEffect, wipeSeams } from "./real.js";
import { deviceWithVaults, vaultFiles } from "./wipe.test-support.js";

const realDeps = wipeSeams.deps;
const bytes = (text: string) => new TextEncoder().encode(text);
const host = { store: {} };

beforeEach(() => {
  clearJournal(WIPE_INTENT_KEY);
  clearEnrollmentStateForUnlock();
});
afterEach(() => {
  wipeSeams.deps = realDeps;
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
});

/** The runner over an in-memory device, so reaching it is observable. */
function observed() {
  const device = deviceWithVaults();
  wipeSeams.deps = device.wipeDeps;
  return device;
}

describe("wipe runner: only a plan it understands", () => {
  it("reads only { v: 1 } as its body", () => {
    expect(isWipeBody({ v: 1 })).toBe(true);
    for (const body of [
      null,
      undefined,
      "wipe",
      1,
      [],
      [1],
      {},
      { v: 2 },
      { v: "1" },
      { v: 1, also: true },
      { v: 1, ids: ["personal"] },
    ]) {
      expect(isWipeBody(body), JSON.stringify(body)).toBe(false);
    }
  });

  it("does nothing for a malformed, foreign or future plan", async () => {
    allowRealWipe();
    const device = observed();
    const plans = [
      { effect: "wipe", body: { v: 2 } },
      { effect: "wipe", body: { v: 1, extra: 1 } },
      { effect: "wipe", body: null },
      { effect: "wipe", body: "WIPE" },
      decodePlan(bytes('{"e":"wipe","v":2,"b":{"v":1}}')),
      decodePlan(bytes('{"e":"wipe","b":{"v":1}}')),
      decodePlan(bytes('{"e":"wipe_everything","v":1,"b":{"v":1}}')),
      decodePlan(bytes("not json")),
      null,
    ] as const;
    for (const plan of plans) {
      await runDuressEffects(plan, "on_match", host);
    }
    expect(device.removals).toEqual([]);
    expect(vaultFiles(device)).not.toHaveLength(0);
  });

  it("wipes for the one plan the wipe mode seals, in the on_match phase only", async () => {
    allowRealWipe();
    const device = observed();
    const mode = getMode("wipe");
    if (!mode?.plan) throw new Error("no wipe mode");
    const plan = decodePlan(encodePlan(mode.plan({ confirm: "WIPE" })));
    await runDuressEffects(plan, "after_session", host);
    expect(device.removals).toEqual([]);
    await runDuressEffects(plan, "on_match", host);
    expect(vaultFiles(device)).toEqual([]);
  });

  it("never lets a failing removal out of the seam", async () => {
    allowRealWipe();
    const device = observed();
    device.wipeDeps.storage.listFiles = async () => {
      throw new Error("storage is gone");
    };
    await expect(runWipeEffect({ v: 1 })).rejects.toThrow();
    await expect(
      runDuressEffects({ effect: "wipe", body: { v: 1 } }, "on_match", host),
    ).resolves.toBeUndefined();
  });
});

describe("wipe runner: the refusal stays on screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configureHost(createTestHost());
  });

  it("brings the store up to date at the next touch of the page, not before", async () => {
    allowRealWipe();
    const listeners = new Map<string, Set<() => void>>();
    const page = {
      addEventListener: (type: string, fn: () => void) =>
        listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
      removeEventListener: (type: string, fn: () => void) =>
        listeners.get(type)?.delete(fn),
    } as unknown as PagePort;
    configureHost(createTestHost({ page }));
    const rehydrate = vi.spyOn(vaultStore, "rehydrate");
    const device = observed();

    await runWipeEffect({ v: 1 });
    // The vaults are gone from storage, and the unlock screen has not moved.
    expect(vaultFiles(device)).toEqual([]);
    expect(rehydrate).not.toHaveBeenCalled();

    for (const fn of [...(listeners.get("keydown") ?? [])]) fn();
    expect(rehydrate).toHaveBeenCalledTimes(1);
    // One touch is enough: the listeners are gone.
    expect([...listeners.values()].flatMap((set) => [...set])).toEqual([]);
  });
});

describe("wipe runner: the test guard", () => {
  it("refuses the real removal while it is forbidden, and records that it was reached", async () => {
    // The setup has forbidden it; this test does not opt in.
    const device = observed();
    await runDuressEffects(
      { effect: "wipe", body: { v: 1 } },
      "on_match",
      host,
    );
    expect(device.removals).toEqual([]);
    expect(vaultFiles(device)).not.toHaveLength(0);
    // The seam swallows a refusal, so the record is what makes it loud: the
    // setup's afterEach fails a test that leaves one. This test takes its own.
    expect(wipeGuard.takeReached()).toEqual(["runWipeEffect"]);
  });

  it("is lifted only by naming it, and only for that test", async () => {
    allowRealWipe();
    const device = observed();
    await runWipeEffect({ v: 1 });
    expect(vaultFiles(device)).toEqual([]);
    expect(wipeGuard.takeReached()).toEqual([]);
  });

  it("is back in force for the next test", async () => {
    const device = observed();
    await runWipeEffect({ v: 1 });
    expect(device.removals).toEqual([]);
    expect(wipeGuard.takeReached()).toEqual(["runWipeEffect"]);
  });
});

describe("wipe runner: arming and removing the code", () => {
  it("never run it: sealing, rehearsing and arming a wipe code remove nothing", async () => {
    allowRealWipe();
    const device = observed();
    const result = await enableDuressCode({
      code: "739104628",
      mode: "wipe",
      extras: { confirm: "WIPE" },
      vaultRef: "personal",
      requireDurable: false,
    });
    expect(result).toEqual({ ok: true });
    expect(device.removals).toEqual([]);
    expect(vaultFiles(device)).not.toHaveLength(0);
  });

  it("refuses to arm a wipe code without the typed word", async () => {
    allowRealWipe();
    const device = observed();
    for (const confirm of [undefined, "", "wip", "WIPE IT"]) {
      const result = await enableDuressCode({
        code: "739104628",
        mode: "wipe",
        ...(confirm === undefined ? {} : { extras: { confirm } }),
        vaultRef: "personal",
        requireDurable: false,
      });
      expect(result, String(confirm)).toEqual({ ok: false, code: "failed" });
    }
    expect(device.removals).toEqual([]);
  });

  it("never run it: removing the code leaves every vault where it is", async () => {
    allowRealWipe();
    const device = observed();
    await enableDuressCode({
      code: "739104628",
      mode: "wipe",
      extras: { confirm: "WIPE" },
      vaultRef: "personal",
      requireDurable: false,
    });
    expect(await removeDuressCode()).toEqual({ ok: true });
    expect(device.removals).toEqual([]);
    expect(vaultFiles(device)).not.toHaveLength(0);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CORE_SRC = join(HERE, "../../..");
const PAGES_SRC = join(APP_CORE_SRC, "../../../apps/pages/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test(-support)?\./.test(entry.name)
      ? [path]
      : [];
  });
}

describe("wipe runner: one road in", () => {
  it("is imported by the effect seam and the boot resume, and nothing else", () => {
    const importers = [...sources(APP_CORE_SRC), ...sources(PAGES_SRC)]
      .filter((file) => /wipe\/real\.js/.test(readFileSync(file, "utf8")))
      .filter((file) => !file.includes(`${join("duress", "wipe")}`))
      .map((file) => relative(join(APP_CORE_SRC, "../../.."), file))
      .sort();
    expect(importers).toEqual([
      "apps/pages/src/bootstrap/boot.ts",
      "packages/app-core/src/lib/duress/settings/modes/effects.ts",
    ]);
  });
});
