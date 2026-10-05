import { afterEach, describe, expect, it } from "vitest";
import { DURESS_BOOT_KEYS, WIPE_INTENT_KEY } from "../store/boot-keys.js";
import { journalSeams } from "../store/journal.js";
import { clearWipeIntent, writeWipeIntent } from "./intent.js";

const real = { ...journalSeams };
const written = new Set<string>();

afterEach(() => {
  Object.assign(journalSeams, real);
  written.clear();
});

describe("the wipe intent and the boot hydrate", () => {
  it("is hydrated by the core boot, every key it is read from", async () => {
    // Journal reads are synchronous: a key the boot does not hydrate reads as
    // absent after a reload, and an interrupted wipe would never resume. The
    // journal's seams see every key it writes, volatile or durable; the real
    // write still runs behind them.
    journalSeams.set = (key, value) => {
      written.add(key);
      real.set(key, value);
    };
    journalSeams.setDurable = async (key, value) => {
      written.add(key);
      await real.setDurable(key, value);
    };
    expect(await writeWipeIntent(["personal"], new Date())).toBe(true);
    expect(written.size).toBeGreaterThan(0);
    for (const stored of written) expect(DURESS_BOOT_KEYS).toContain(stored);
    expect(DURESS_BOOT_KEYS).toContain(WIPE_INTENT_KEY);
    await clearWipeIntent();
  });
});
