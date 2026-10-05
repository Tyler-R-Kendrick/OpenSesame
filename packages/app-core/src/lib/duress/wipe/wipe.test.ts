/**
 * The wipe primitive over an in-memory origin: what goes, what stays, the
 * order, and a page that dies between the phases.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { headerOf } from "../../travel/storage.js";
import { WIPE_INTENT_KEY } from "../store/boot-keys.js";
import { clearJournal } from "../store/journal.js";
import {
  readWipeIntent,
  wipeIntentPending,
  writeWipeIntent,
} from "./intent.js";
import { isProtectedFile } from "./targets.js";
import { resumeWipe, wipeDevice } from "./wipe.js";
import {
  KEPT_FILES,
  PRJ_TRIP,
  PRJ_WORK,
  deviceWithVaults,
  vaultFiles,
} from "./wipe.test-support.js";

beforeEach(() => {
  clearJournal(WIPE_INTENT_KEY);
});

describe("wipe: what goes and what stays", () => {
  it("removes every vault's files, and only those", async () => {
    const device = deviceWithVaults();
    expect(vaultFiles(device)).not.toHaveLength(0);
    const before = new Map(device.files);

    const receipt = await wipeDevice(device.wipeDeps);

    expect(vaultFiles(device)).toEqual([]);
    // The lockout counters named for a vault go with it.
    expect(
      [...device.files.keys()].filter((f) => f.includes("attempts")),
    ).toEqual([]);
    for (const file of KEPT_FILES) {
      expect(device.files.get(file), file).toBe(before.get(file));
    }
    expect(receipt.completion).toBe("applied_local");
    expect(receipt.assurance).toBe("application_scoped_removal");
    expect(receipt.leftovers).toEqual([]);
    expect(receipt.intentRecorded).toBe(true);
  });

  it("never names a guest tomb, the duress journals or the settings", async () => {
    const device = deviceWithVaults();
    await wipeDevice(device.wipeDeps);
    for (const file of KEPT_FILES) expect(device.removals).not.toContain(file);
    expect(device.tombs.has("guest")).toBe(true);
    expect(device.tombs.has("guest-scratch")).toBe(true);
    expect(device.tombs.has("personal")).toBe(false);
    expect(device.tombs.has(PRJ_WORK)).toBe(false);
  });

  it("treats every duress journal file as protected, whatever ownership says", () => {
    for (const file of KEPT_FILES.filter((f) => f.includes("duress"))) {
      expect(isProtectedFile(file), file).toBe(true);
    }
  });

  it("removes every header before any other file", async () => {
    const device = deviceWithVaults();
    await wipeDevice(device.wipeDeps);
    const headers = new Set(
      ["personal", PRJ_WORK, PRJ_TRIP].map((id) => headerOf(id)),
    );
    const lastHeader = Math.max(
      ...[...headers].map((h) => device.removals.indexOf(h)),
    );
    const firstOther = device.removals.findIndex((f) => !headers.has(f));
    expect(lastHeader).toBeGreaterThanOrEqual(0);
    expect(firstOther).toBeGreaterThan(lastHeader);
  });

  it("forgets the vaults it removed and says which", async () => {
    const device = deviceWithVaults();
    await wipeDevice(device.wipeDeps);
    expect(device.gone).toEqual([["personal", PRJ_TRIP, PRJ_WORK].sort()]);
    expect(device.forgotten.flat().length).toBeGreaterThan(0);
  });

  it("clears its intent once removal is confirmed", async () => {
    const device = deviceWithVaults();
    await wipeDevice(device.wipeDeps);
    expect(wipeIntentPending()).toBe(false);
  });

  it("keeps its intent, and says incomplete, when a file will not go", async () => {
    const device = deviceWithVaults();
    const stuck = vaultFiles(device).find((f) => f.endsWith("prefs.json"));
    if (!stuck) throw new Error("no file to stick");
    device.stuck.add(stuck);
    const receipt = await wipeDevice(device.wipeDeps);
    expect(receipt.completion).toBe("incomplete");
    expect(receipt.leftovers).toEqual([stuck]);
    // The header went first, so what is left cannot be unlocked.
    expect(device.files.has(headerOf("personal"))).toBe(false);
    expect(wipeIntentPending()).toBe(true);
  });
});

describe("wipe: a page that dies between the phases", () => {
  /** Removal that goes quiet after `n` files, as a tab closed mid-delete. */
  function dieAfter(device: ReturnType<typeof deviceWithVaults>, n: number) {
    const { remove } = device.wipeDeps.storage;
    let count = 0;
    device.wipeDeps.storage.remove = (file) => {
      count += 1;
      return count > n ? new Promise<void>(() => {}) : remove(file);
    };
    return () => {
      device.wipeDeps.storage.remove = remove;
    };
  }

  it("leaves no vault openable, and resumes to completion at the next boot", async () => {
    const device = deviceWithVaults();
    const heal = dieAfter(device, 3);
    const hung = wipeDevice(device.wipeDeps);
    await Promise.race([hung, new Promise((r) => setTimeout(r, 50))]);

    // All three headers were taken first; bodies and files are still there.
    for (const id of ["personal", PRJ_WORK, PRJ_TRIP]) {
      expect(device.files.has(headerOf(id)), id).toBe(false);
    }
    expect(vaultFiles(device).length).toBeGreaterThan(0);
    expect(wipeIntentPending()).toBe(true);
    expect(readWipeIntent()?.ids).toEqual(
      ["personal", PRJ_TRIP, PRJ_WORK].sort(),
    );

    // A new page: healthy storage, the intent read back from the journal.
    heal();
    const receipt = await resumeWipe(device.wipeDeps);

    expect(receipt?.completion).toBe("applied_local");
    expect(vaultFiles(device)).toEqual([]);
    for (const file of KEPT_FILES)
      expect(device.files.has(file), file).toBe(true);
    expect(wipeIntentPending()).toBe(false);
  });

  it("does nothing at boot when no wipe began", async () => {
    const device = deviceWithVaults();
    const before = new Map(device.files);
    expect(await resumeWipe(device.wipeDeps)).toBeNull();
    expect(device.removals).toEqual([]);
    expect(device.files).toEqual(before);
  });

  it("makes one attempt: a stuck file cannot cost a vault made later", async () => {
    const device = deviceWithVaults();
    await writeWipeIntent(["personal"], new Date());
    const stuck = vaultFiles(device).find((f) => f.endsWith("prefs.json"));
    if (!stuck) throw new Error("no file to stick");
    device.stuck.add(stuck);
    await resumeWipe(device.wipeDeps);
    expect(wipeIntentPending()).toBe(false);
  });

  it("never follows an intent that names a guest tomb or a path", async () => {
    const device = deviceWithVaults();
    await writeWipeIntent(
      ["guest", "guest-scratch", "../x", "personal"],
      new Date(),
    );
    await resumeWipe(device.wipeDeps);
    for (const file of KEPT_FILES)
      expect(device.files.has(file), file).toBe(true);
    expect(device.files.has(headerOf("personal"))).toBe(false);
    expect(device.files.has(headerOf(PRJ_WORK))).toBe(true);
  });

  it("leaves an intent it cannot read alone, and removes nothing", async () => {
    const device = deviceWithVaults();
    const { kvSet } = await import("../../kv.js");
    kvSet(
      WIPE_INTENT_KEY,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "",
        payload: { v: 2, ids: ["personal"], startedAt: "" },
      }),
    );
    expect(wipeIntentPending()).toBe(true);
    expect(await resumeWipe(device.wipeDeps)).toBeNull();
    expect(device.removals).toEqual([]);
    expect(wipeIntentPending()).toBe(true);
  });
});
